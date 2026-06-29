/**
 * The headline end-to-end test (design 12 §11): two machines, full E2EE, and a
 * ZERO-KNOWLEDGE assertion over everything the server stores.
 *
 * Machine A bootstraps an account + workspace, encrypts a manifest with secret
 * filenames + contents, commits. A `FakeServer` stores EXACTLY what the real
 * Worker stores: opaque ciphertext blobs, opaque signed commit envelopes, and
 * opaque key/roster blobs — it never sees a KEK or plaintext. Machine B pairs in
 * (gets MK via the token-derived wrap + admits itself to the roster), pulls,
 * verifies the signed commit against the roster, and decrypts byte-identically.
 *
 * Then we dump every byte the server holds and grep for the known plaintext
 * filenames/contents → MUST be zero hits.
 */
import { describe, expect, test } from "bun:test";
import {
  bootstrapAccount,
  buildCommit,
  buildPairing,
  createWorkspaceKey,
  openCommit,
  openWorkspaceKey,
  redeemPairing,
  verifyAccount,
  type DeviceSecrets,
  type PairingMaterial,
} from "./session.js";
import { GENESIS_PARENT_HASH, type BlobRef, type SignedCommit } from "./commit.js";
import { encryptFileNameProbe } from "./e2ee-e2e.helpers.js";
import { fromB64url, randomBytes, sha256Hex, toB64url, utf8 } from "./primitives.js";
import type { SignedRoster, SignedKeyState, Wrap } from "./index.js";

const NOW = 1_900_000_000_000;
const SECRET_PATH = "src/totally-secret-filename.ts";
const SECRET_CONTENT = "const API_KEY = 'sk-do-not-leak-this-value-anywhere';";

/** A faithful stand-in for the Worker+DO+R2+D1: stores only opaque bytes/JSON. */
class FakeServer {
  blobs = new Map<string, Uint8Array>(); // encSha -> ciphertext (incl. encrypted manifests)
  commits: SignedCommit[] = []; // the per-seq signed envelopes (DO storage)
  rosters: SignedRoster[] = [];
  keyStates: SignedKeyState[] = [];
  deviceKeys: Array<{ deviceId: string; mkWrap: Wrap }> = [];
  workspaceKeys = new Map<string, Wrap>(); // workspaceId -> kek wrap
  pairing = new Map<string, PairingMaterial>(); // tokenId -> material
  recoveryWrap?: Wrap;

  putBlob(sha: string, bytes: Uint8Array) {
    this.blobs.set(sha, bytes);
  }
  has(sha: string) {
    return this.blobs.has(sha);
  }
  /** The DO commit path: validate blob existence + parent, store the envelope. */
  commit(parentSeq: number, c: SignedCommit) {
    const body = JSON.parse(c.body) as { seq: number; parentSeq: number; encManifestSha: string; blobRefs: BlobRef[] };
    for (const ref of [body.encManifestSha, ...body.blobRefs.map((r) => r.encSha)]) {
      if (!this.blobs.has(ref)) throw new Error(`422 unsatisfied_blobs: ${ref}`);
    }
    const head = this.commits.length;
    if (parentSeq !== head) throw new Error(`409 conflict head=${head}`);
    this.commits.push(c);
  }
  latest(): { sequence: number; commit: SignedCommit | null } {
    return this.commits.length === 0 ? { sequence: 0, commit: null } : { sequence: this.commits.length, commit: this.commits[this.commits.length - 1]! };
  }
  /** Every byte the operator could inspect. */
  allStoredBytes(): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const b of this.blobs.values()) out.push(b);
    const text = (o: unknown) => utf8(JSON.stringify(o));
    out.push(text(this.commits), text(this.rosters), text(this.keyStates), text(this.deviceKeys), text([...this.workspaceKeys]), text([...this.pairing]), text(this.recoveryWrap ?? null));
    return out;
  }
}

async function machineAInit(server: FakeServer) {
  const accountId = "acct_zk";
  const boot = await bootstrapAccount(accountId, "devA", NOW);
  // upload opaque key material
  server.rosters.push(boot.upload.genesisRoster);
  server.keyStates.push(boot.upload.genesisKeyState);
  server.deviceKeys.push({ deviceId: "devA", mkWrap: boot.upload.device.mkWrap });
  server.recoveryWrap = boot.upload.recoveryWrap;

  const workspaceId = "ws_zk";
  const { kek, kekWrap } = await createWorkspaceKey(boot.secrets, workspaceId);
  server.workspaceKeys.set(workspaceId, kekWrap);
  return { accountId, workspaceId, secrets: boot.secrets, kek, recoveryPhrase: boot.recoveryPhrase };
}

/** Encrypt the workspace's blobs + manifest and commit (machine A). */
async function commitSecretTree(server: FakeServer, ctx: { accountId: string; workspaceId: string; secrets: DeviceSecrets; kek: Uint8Array }) {
  // one file blob, convergently encrypted via the manifest-crypto-independent blob path
  const probe = await encryptFileNameProbe(ctx.kek, utf8(SECRET_CONTENT));
  server.putBlob(probe.encSha, probe.ciphertext);

  const manifest = utf8(JSON.stringify({ generatedAt: "t", files: [{ path: SECRET_PATH, sha256: probe.plaintextSha, encSha: probe.encSha, size: SECRET_CONTENT.length, type: "file", mode: 420, mtimeMs: 0 }] }));
  const built = await buildCommit({
    secrets: ctx.secrets,
    workspaceId: ctx.workspaceId,
    kek: ctx.kek,
    keyEpoch: 0,
    accountEpoch: 0,
    rosterVersion: 0,
    seq: 1,
    parentSeq: 0,
    parentCommitHash: GENESIS_PARENT_HASH,
    manifestJson: manifest,
    blobRefs: [{ encSha: probe.encSha, size: probe.ciphertext.length }],
  });
  server.putBlob(built.encManifestSha, built.encManifest);
  server.commit(0, built.commit);
  return { manifest };
}

describe("full E2EE — two machines + zero-knowledge server", () => {
  test("A commits, B pairs in and decrypts byte-identically", async () => {
    const server = new FakeServer();
    const a = await machineAInit(server);
    const { manifest } = await commitSecretTree(server, a);

    // ---- Machine B pairs in ----
    const tokenSecret = randomBytes(32);
    const tokenId = "tok_pair_1";
    const material = await buildPairing(a.secrets, { accountEpoch: 0, tokenId, tokenSecret, notAfter: NOW + 600_000 });
    server.pairing.set(tokenId, material); // server stores opaque material

    // B redeems: unwrap MK, admit itself, upload its device wrap + new roster.
    const headRoster = server.rosters[server.rosters.length - 1]!;
    const redeem = await redeemPairing({ accountId: a.accountId, deviceId: "devB", tokenSecret, accountEpoch: 0, material: server.pairing.get(tokenId)!, prevRoster: headRoster, now: NOW + 1000 });
    server.rosters.push(redeem.admissionRoster);
    server.deviceKeys.push({ deviceId: "devB", mkWrap: redeem.device.mkWrap });

    // ---- Machine B pulls + verifies + decrypts ----
    const account = await verifyAccount(server.rosters, server.keyStates, NOW + 2000);
    expect(account.rosters).toHaveLength(2); // genesis + B's admission
    const kekWrap = server.workspaceKeys.get(a.workspaceId)!;
    const bKek = await openWorkspaceKey(redeem.secrets, kekWrap);
    expect(toB64url(bKek)).toBe(toB64url(a.kek)); // B unwrapped the same KEK via paired MK

    const { commit } = server.latest();
    const decrypted = await openCommit({ secrets: redeem.secrets, kek: bKek, account, commit: commit!, encManifest: server.blobs.get(JSON.parse(commit!.body).encManifestSha)!, workspaceId: a.workspaceId });
    expect(Buffer.from(decrypted).toString("utf8")).toBe(Buffer.from(manifest).toString("utf8"));
    expect(Buffer.from(decrypted).toString("utf8")).toContain(SECRET_PATH);
  });

  test("ZERO-KNOWLEDGE: no plaintext filename/content in anything the server stores", async () => {
    const server = new FakeServer();
    const a = await machineAInit(server);
    await commitSecretTree(server, a);

    const needles = [SECRET_PATH, "totally-secret-filename", SECRET_CONTENT, "sk-do-not-leak-this-value-anywhere", "API_KEY"];
    for (const bytes of server.allStoredBytes()) {
      const buf = Buffer.from(bytes);
      for (const needle of needles) {
        expect(buf.includes(Buffer.from(needle))).toBe(false);
      }
    }
  });

  test("a device NOT in the roster cannot pass commit verification", async () => {
    const server = new FakeServer();
    const a = await machineAInit(server);
    await commitSecretTree(server, a);
    const account = await verifyAccount(server.rosters, server.keyStates, NOW + 2000);
    // forge a commit signed by a stranger key but claiming devA
    const stranger = await bootstrapAccount(a.accountId, "devA", NOW); // different keys, same deviceId
    const built = await buildCommit({
      secrets: { ...stranger.secrets, accountId: a.accountId },
      workspaceId: a.workspaceId,
      kek: a.kek,
      keyEpoch: 0,
      accountEpoch: 0,
      rosterVersion: 0,
      seq: 1,
      parentSeq: 0,
      parentCommitHash: GENESIS_PARENT_HASH,
      manifestJson: utf8("{}"),
      blobRefs: [],
    });
    server.putBlob(built.encManifestSha, built.encManifest);
    await expect(
      openCommit({ secrets: a.secrets, kek: a.kek, account, commit: built.commit, encManifest: built.encManifest, workspaceId: a.workspaceId })
    ).rejects.toThrow(/signature invalid/);
  });
});
