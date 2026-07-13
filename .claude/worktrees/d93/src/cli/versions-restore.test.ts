import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreEntryToPath } from "../engine/index.js";
import type { E2eeRemote } from "./e2ee-remote.js";
import { NeedsRebaselineError } from "./remote.js";
import { bootstrapOnto, cfgFor, FakeServer, remoteFor } from "./e2ee-fake-server.js";
import { push } from "./sync.js";

const NOW = 1_900_000_000_000;
const ACCT = "acct_vh";
const WS = "ws_vh";
const FILE = "notes.txt";
const V1 = "version one — the original\n";
const V2 = "version two — edited later\n";

let dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-vh-"));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

/** Bootstrap an account, push v1 then v2 of a file, and return the live harness. */
async function twoVersions(): Promise<{ server: FakeServer; remote: E2eeRemote; root: string }> {
  const server = new FakeServer();
  const secrets = await bootstrapOnto(server, ACCT, "devA", NOW);
  const root = await tmp();
  const remote = remoteFor(server, secrets, ACCT, WS, NOW + 5000);
  const cfg = await cfgFor(root, secrets, remote, WS);

  await fs.writeFile(path.join(root, FILE), V1);
  expect((await push(root, cfg, { remote })).sequence).toBe(1);

  await fs.writeFile(path.join(root, FILE), V2);
  await fs.writeFile(path.join(root, "added.txt"), "only in v2\n"); // a file absent at seq 1
  expect((await push(root, cfg, { remote })).sequence).toBe(2);

  return { server, remote, root };
}

describe("E2EE version history + restore (design 12 §15)", () => {
  test("CARDINAL: restore <file>@1 yields the exact decrypted v1 bytes after v2 is the head", async () => {
    const { remote, root } = await twoVersions();
    // disk currently holds v2
    expect(await fs.readFile(path.join(root, FILE), "utf8")).toBe(V2);

    const { manifest, kek } = await remote.manifestAtSeq(1);
    const entry = manifest.files.find((f) => f.path === FILE);
    expect(entry).toBeDefined();
    await restoreEntryToPath(root, entry!, remote.blobStore(), Buffer.from(kek));

    // The cardinal assertion: the on-disk file is byte-identical to the v1 content.
    expect(await fs.readFile(path.join(root, FILE), "utf8")).toBe(V1);
  });

  test("versions lists the full verified chain newest-first (seq + device)", async () => {
    const { remote } = await twoVersions();
    const versions = await remote.history(50);
    expect(versions.map((v) => v.seq)).toEqual([2, 1]);
    expect(versions.every((v) => v.deviceId === "devA")).toBe(true);
    expect(versions.every((v) => v.keyEpoch === 0)).toBe(true);
  });

  test("versions <path> reports the seqs where that file's content changed", async () => {
    const { remote } = await twoVersions();
    const changes = await remote.pathHistory(FILE, 50);
    // changed at seq 1 (first appearance) and seq 2 (edited) — newest-first.
    expect(changes.map((c) => c.seq)).toEqual([2, 1]);
    expect(changes[0]!.sha256).not.toBe(changes[1]!.sha256); // distinct content per version
  });

  test("decode-boundary validation rejects invalid historical manifests before restore decrypts blobs", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-invalid-schema", NOW);
    const root = await tmp();
    const remote = remoteFor(server, secrets, ACCT, WS, NOW + 5000);
    const fileEncSha = "f".repeat(64);
    server.store.blobs.set(fileEncSha, new Uint8Array([1, 2, 3]));

    const invalidManifest = {
      generatedAt: "",
      manifestSchema: 3,
      files: [
        {
          path: FILE,
          type: "file",
          sha256: "1".repeat(64),
          encSha: fileEncSha,
          size: 10,
          mode: 0o644,
          mtimeMs: 0,
          comp: "zstd",
          payloadSha: "2".repeat(64),
          cipherSize: 3,
        },
      ],
    } as const;
    expect(await remote.commit(0, secrets.deviceId, invalidManifest)).toEqual({ sequence: 1 });

    let fileBlobReads = 0;
    const originalGet = server.store.get.bind(server.store);
    server.store.get = async (sha: string) => {
      if (sha === fileEncSha) fileBlobReads++;
      return originalGet(sha);
    };

    await expect(
      (async () => {
        const { manifest, kek } = await remote.manifestAtSeq(1);
        const entry = manifest.files.find((f) => f.path === FILE)!;
        await restoreEntryToPath(root, entry, remote.blobStore(), Buffer.from(kek));
      })()
    ).rejects.toThrow("compressed entries require manifestSchema >= 4");
    await expect(remote.pathHistory(FILE, 50)).rejects.toThrow("compressed entries require manifestSchema >= 4");
    expect(fileBlobReads).toBe(0);
  });

  test("manifest@1 does not contain a file that was only added at seq 2", async () => {
    const { remote } = await twoVersions();
    const { manifest } = await remote.manifestAtSeq(1);
    expect(manifest.files.some((f) => f.path === "added.txt")).toBe(false);
    expect(manifest.files.some((f) => f.path === FILE)).toBe(true);
  });

  test("FAIL CLOSED: a tampered historical encrypted-manifest blob is rejected", async () => {
    const { server, remote } = await twoVersions();
    // Corrupt the seq-1 commit's encrypted-manifest blob in place (server can't see
    // plaintext, but a bit-flip must be caught by the signed encManifestSha check).
    const c1 = JSON.parse(server.commits[0]!.body) as { encManifestSha: string };
    const good = server.store.blobs.get(c1.encManifestSha)!;
    const bad = new Uint8Array(good);
    bad[0]! ^= 0xff;
    server.store.blobs.set(c1.encManifestSha, bad);

    await expect(remote.manifestAtSeq(1)).rejects.toThrow(/encManifest does not match|decrypt|integrity/i);
  });

  test("FAIL CLOSED: a tampered commit envelope breaks chain verification", async () => {
    const { server, remote } = await twoVersions();
    // Flip a byte in the stored seq-1 signature → its sig no longer verifies, so the
    // head-chain verification (and any historical segment) rejects the whole chain.
    const c1 = server.commits[0]!;
    server.commits[0] = { ...c1, commitHash: c1.commitHash.slice(0, -1) + (c1.commitHash.endsWith("0") ? "1" : "0") };

    await expect(remote.manifestAtSeq(1)).rejects.toThrow();
    await expect(remote.history(50)).rejects.toThrow();
  });

  test("FAIL CLOSED: restoring a version pruned past retention surfaces a clear error", async () => {
    const { server, remote } = await twoVersions();
    server.pruneFloor = 1; // seq 1's pointer dropped; commitsSince(0) → needs_rebaseline
    // Head (seq 2) still restorable; the aged-out seq 1 must fail closed.
    await expect(remote.manifestAtSeq(2)).resolves.toBeDefined();
    await expect(remote.manifestAtSeq(1)).rejects.toBeInstanceOf(NeedsRebaselineError);
  });
});
