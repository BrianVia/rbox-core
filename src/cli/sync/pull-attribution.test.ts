import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PhaseReport,
  scanManifest,
  type Action,
  type BlobStore,
  type DirCacheFile,
  type FileEntry,
  type HashCacheEntry,
  type Manifest,
  type RuleFileRecord,
} from "../../engine/index.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import { applyPulledManifest, MassDeleteGuardError, push, type SyncDeps, TrustedViewRefusalError, type TrustedLocalView } from "../sync.js";
import { saveStateUnsafeLegacyOrTest, syncStreamId, type WorkspaceConfig } from "../config.js";
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
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(config(root)),
    stateNonce: "a".repeat(32),
    stateRevision: 0,
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
  return root;
}

type DiskEntry =
  | { kind: "directory" }
  | { kind: "symlink"; target: string }
  | { kind: "file"; mode: number; bytes: string };

async function snapshot(root: string): Promise<Record<string, DiskEntry>> {
  const out: Record<string, DiskEntry> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await fs.readdir(path.join(root, dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      const abs = path.join(root, rel);
      if (entry.isDirectory()) {
        out[`${rel}/`] = { kind: "directory" };
        await walk(rel);
      } else if (entry.isSymbolicLink()) {
        out[rel] = { kind: "symlink", target: await fs.readlink(abs) };
      } else {
        const bytes = await fs.readFile(abs);
        out[rel] = { kind: "file", mode: (await fs.stat(abs)).mode & 0o777, bytes: bytes.toString("base64") };
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
  let actions: Action[] | undefined;
  let error:
    | { name: "MassDeleteGuardError"; message: string; op: "pull" | "push" }
    | { name: "TrustedViewRefusalError"; message: string; reason: "mass-delete" }
    | { name: string; message: string }
    | undefined;
  try {
    actions = await applyPulledManifest(root, config(root), deps, remote, await remote.latest(), trustedView);
  } catch (caught) {
    const value = caught as Error;
    // Error.stack is run/location-specific. Capture every semantic field owned
    // by the typed errors this matrix expects, not merely their display text.
    error = value instanceof MassDeleteGuardError
      ? { name: value.name, message: value.message, op: value.op }
      : value instanceof TrustedViewRefusalError
        ? { name: value.name, message: value.message, reason: value.reason }
        : { name: value.constructor.name, message: value.message };
  }
  return { actions, error, adopted, disk: await snapshot(root), report: report.toJSON() };
}

type ComparedOutcome = Pick<Awaited<ReturnType<typeof run>>, "actions" | "error" | "disk">;

function withoutLocalObservedMtime(entry: FileEntry | undefined): Omit<FileEntry, "mtimeMs"> | undefined {
  if (!entry) return undefined;
  // FileEntry.mtimeMs is explicitly a receiver-local scan fast-path hint, not
  // content identity. Separate copied roots can observe different mtimes.
  const { mtimeMs: _observedMtimeMs, ...content } = entry;
  return content;
}

function canonicalAction(action: Action) {
  if (action.kind === "write") {
    // entry is the shared remote input and stays exact. expectedLocal is a scan
    // observation of each copied root, so only its mtime hint may differ.
    return { ...action, expectedLocal: withoutLocalObservedMtime(action.expectedLocal) };
  }
  if (action.kind === "delete") {
    return { ...action, expectedLocal: withoutLocalObservedMtime(action.expectedLocal) };
  }
  return action;
}

function canonicalJsonDiskFile(rel: string, bytes: string): unknown | undefined {
  const decoded = Buffer.from(bytes, "base64").toString("utf8");
  if (rel === ".rbox/state/last-writer.json") {
    const witness = JSON.parse(decoded) as LastWriterWitness;
    // writtenAtMs is the wall-clock publication instant. stateMtimeMs, stateDev,
    // and stateIno bind that publication to this copy's physical file. All four
    // legitimately differ between independent on/off roots; body hash and size do not.
    const { writtenAtMs: _writtenAtMs, stateMtimeMs: _stateMtimeMs, stateDev: _stateDev, stateIno: _stateIno, ...durable } = witness;
    return durable;
  }
  if (rel === ".rbox/state/hashcache.json") {
    const cache = JSON.parse(decoded) as { version: number; gitPolicy?: unknown; entries: Record<string, HashCacheEntry> };
    // Cache mtime/ctime pairs are receiver-local stat fingerprints. Entries are
    // recorded from a concurrent hash batch, so their JSON member order is not
    // meaningful; sorted reconstruction makes that explicit.
    const entries = Object.fromEntries(Object.entries(cache.entries).sort(([a], [b]) => a.localeCompare(b)).map(([entryPath, entry]) => {
      const { mtimeMs: _mtimeMs, ctimeMs: _ctimeMs, ...stable } = entry;
      return [entryPath, stable];
    }));
    return { ...cache, entries };
  }
  if (rel === ".rbox/state/dircache.json") {
    const cache = JSON.parse(decoded) as DirCacheFile;
    // Scan headers and directory/rule mtime/ctime pairs describe when this root
    // was observed, not its contents. readdir inventory order is filesystem- and
    // scheduler-dependent, so map keys, rule records, and child records are sorted.
    const ruleFiles = cache.ruleFiles.map((rule): Omit<RuleFileRecord, "mtimeMs" | "ctimeMs"> => {
      if ("absent" in rule) return rule;
      const { mtimeMs: _mtimeMs, ctimeMs: _ctimeMs, ...stable } = rule;
      return stable;
    }).sort((a, b) => a.relPath.localeCompare(b.relPath));
    const entries = Object.fromEntries(Object.entries(cache.entries).sort(([a], [b]) => a.localeCompare(b)).map(([entryPath, entry]) => {
      const { mtimeMs: _mtimeMs, ctimeMs: _ctimeMs, children } = entry;
      return [entryPath, { children: [...children].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)) }];
    }));
    const { lastScanStartMs: _lastScanStartMs, lastUnprunedScanAtMs: _lastUnprunedScanAtMs, ...stable } = cache;
    return { ...stable, ruleFiles, entries };
  }
  return undefined;
}

function canonicalOutcome(outcome: ComparedOutcome) {
  const disk = Object.fromEntries(Object.entries(outcome.disk).sort(([a], [b]) => a.localeCompare(b)).map(([rel, entry]) => {
    if (entry.kind !== "file") return [rel, entry];
    const json = canonicalJsonDiskFile(rel, entry.bytes);
    return [rel, json === undefined ? entry : { kind: "file", mode: entry.mode, json }];
  }));
  return {
    actions: outcome.actions?.map(canonicalAction),
    error: outcome.error,
    disk,
  };
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
    const [off, on] = await Promise.all([
      run(offRoot, remote, false, scenario),
      run(onRoot, remote, true, scenario),
    ]);

    expect(canonicalOutcome(on)).toEqual(canonicalOutcome(off));
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
