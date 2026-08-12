import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PhaseReport, scanManifest, type BlobStore, type FileEntry, type Manifest } from "../../engine/index.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import { applyPulledManifest, push, type SyncDeps, type TrustedLocalView } from "../sync.js";
import type { WorkspaceConfig } from "../config.js";
import type { CommitResult, SyncRemote } from "../remote.js";
import type { LastWriterWitness } from "../state-plane/migration/last-writer-witness.js";

const KEK = Buffer.alloc(32, 23);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

class DifferentialRemote implements SyncRemote {
  head = 0;
  private manifest: Manifest = { generatedAt: "", files: [] };
  private readonly blobs = new Map<string, Buffer>();
  failReads = false;

  async entry(rel: string, content: string): Promise<FileEntry> {
    const encrypted = await encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));
    this.blobs.set(encrypted.encSha, Buffer.from(encrypted.ciphertext));
    return { path: rel, type: "file", sha256: encrypted.plaintextSha, encSha: encrypted.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }

  advance(files: FileEntry[]): void {
    this.head++;
    this.manifest = { generatedAt: "", files };
  }

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.manifest };
  }

  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((sha) => !this.blobs.has(sha));
  }

  async putBlobFile(sha: string, absPath: string): Promise<void> {
    this.blobs.set(sha, await fs.readFile(absPath));
  }

  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    this.head++;
    this.manifest = manifest;
    return { sequence: this.head };
  }

  blobStore(): BlobStore {
    return {
      has: async (sha) => this.blobs.has(sha),
      put: async (sha, bytes) => void this.blobs.set(sha, Buffer.from(bytes)),
      get: async (sha) => {
        if (this.failReads) throw new Error("injected blob read failure");
        const bytes = this.blobs.get(sha);
        if (!bytes) throw new Error(`missing blob ${sha}`);
        return bytes;
      },
      getToFile: async (sha, dest) => {
        if (this.failReads) throw new Error("injected blob read failure");
        const bytes = this.blobs.get(sha);
        if (!bytes) throw new Error(`missing blob ${sha}`);
        await fs.writeFile(dest, bytes);
      },
    };
  }
}

function config(root: string): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_attribution",
    projectId: "root",
    deviceId: "device_a",
    rootPath: root,
    remoteUrl: "mem://",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_attribution",
    accountEpoch: 0,
    keyEpoch: 0,
  };
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  await fs.mkdir(path.join(root, ".rbox/state"), { recursive: true });
  return root;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await fs.readdir(path.join(root, dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      const abs = path.join(root, rel);
      if (entry.isDirectory()) {
        out[`${rel}/`] = "dir";
        await walk(rel);
      } else if (entry.isSymbolicLink()) {
        out[rel] = `link:${await fs.readlink(abs)}`;
      } else {
        const bytes = await fs.readFile(abs);
        if (rel === ".rbox/state/last-writer.json") {
          const witness = JSON.parse(bytes.toString("utf8")) as LastWriterWitness;
          // The witness binds the copied state's new physical inode. Compare every
          // durable field except that necessarily root-specific filesystem identity.
          delete witness.stateDev;
          delete witness.stateIno;
          out[rel] = JSON.stringify(witness);
        } else {
          out[rel] = `${(await fs.stat(abs)).mode & 0o777}:${createHash("sha256").update(bytes).digest("hex")}:${bytes.toString("base64")}`;
        }
      }
    }
  };
  await walk("");
  return out;
}

type Scenario = "success" | "mass-delete" | "trusted-view" | "thrown-error";

async function run(root: string, remote: DifferentialRemote, enabled: boolean, scenario: Scenario) {
  const report = enabled ? PhaseReport.pull() : PhaseReport.disabled("pull");
  let adopted: { sequence: number; phaseMs?: Record<string, number> } | undefined;
  const deps: SyncDeps = {
    remote,
    backoff: async () => {},
    report,
    onPullAdopted: (sequence, phaseMs) => {
      adopted = { sequence };
      if (phaseMs) adopted.phaseMs = phaseMs;
    },
  };
  const trustedView: TrustedLocalView | undefined = scenario === "trusted-view"
    ? { manifest: await scanManifest(root), deferred: new Set() }
    : undefined;
  let actions: unknown;
  let error: { name: string; message: string } | undefined;
  try {
    actions = await applyPulledManifest(root, config(root), deps, remote, await remote.latest(), trustedView);
  } catch (caught) {
    const value = caught as Error;
    error = { name: value.constructor.name, message: value.message };
  }
  return { actions, error, adopted, disk: await snapshot(root), report: report.toJSON() };
}

test("receiver attribution is observation-only through the live state load/save path", async () => {
  for (const scenario of ["success", "mass-delete", "trusted-view", "thrown-error"] as const) {
    const seed = await makeRoot(`rbox-attribution-${scenario}-seed-`);
    const remote = new DifferentialRemote();
    if (scenario === "mass-delete" || scenario === "trusted-view") {
      for (let i = 0; i < 100; i++) await fs.writeFile(path.join(seed, `f${i}.txt`), `${i}`);
    }
    await push(seed, config(seed), { remote, backoff: async () => {}, report: PhaseReport.disabled("push") });

    if (scenario === "success") remote.advance([await remote.entry("received.txt", "received")]);
    else if (scenario === "thrown-error") {
      remote.advance([await remote.entry("received.txt", "received")]);
      remote.failReads = true;
    } else remote.advance([]);

    const offRoot = await makeRoot(`rbox-attribution-${scenario}-off-`);
    const onRoot = await makeRoot(`rbox-attribution-${scenario}-on-`);
    await Promise.all([
      fs.cp(seed, offRoot, { recursive: true, force: true }),
      fs.cp(seed, onRoot, { recursive: true, force: true }),
    ]);
    const realDateNow = Date.now;
    Date.now = () => 1_786_565_400_000;
    let off: Awaited<ReturnType<typeof run>>;
    let on: Awaited<ReturnType<typeof run>>;
    try {
      [off, on] = await Promise.all([
        run(offRoot, remote, false, scenario),
        run(onRoot, remote, true, scenario),
      ]);
    } finally {
      Date.now = realDateNow;
    }

    expect({ actions: on.actions, error: on.error, disk: on.disk }).toEqual({ actions: off.actions, error: off.error, disk: off.disk });
    if (scenario === "success") {
      expect(on.adopted?.phaseMs).toEqual(expect.objectContaining({ validate: expect.any(Number), reconcile: expect.any(Number), "git-apply": expect.any(Number) }));
      expect(off.adopted?.phaseMs).toBeUndefined();
      expect(on.report.phases["git-apply"]?.details).toMatchObject({
        oracle: { prepareMs: 0, receiptHashMs: 0, entriesIndexed: 0, reposProved: 0 },
      });
    } else {
      expect(on.adopted).toBeUndefined();
      expect(off.adopted).toBeUndefined();
    }
  }
});
