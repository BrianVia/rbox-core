import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BlobStore, FileEntry, IgnoreMatcher, Manifest } from "../../engine/index.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import { applyPulledManifest, type SyncDeps } from "../sync.js";
import { saveStateUnsafeLegacyOrTest, syncStreamId, type WorkspaceConfig } from "../config.js";
import type { CommitResult, SyncRemote } from "../remote.js";

const KEK = Buffer.alloc(32, 23);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

class MemoryRemote implements SyncRemote {
  head = 0;
  private manifest: Manifest = { generatedAt: "", files: [] };
  private readonly blobs = new Map<string, Buffer>();

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

  async commit(): Promise<CommitResult> {
    throw new Error("pull-only harness");
  }

  blobStore(): BlobStore {
    return {
      has: async (sha) => this.blobs.has(sha),
      put: async (sha, bytes) => void this.blobs.set(sha, Buffer.from(bytes)),
      get: async (sha) => {
        const bytes = this.blobs.get(sha);
        if (!bytes) throw new Error(`missing blob ${sha}`);
        return bytes;
      },
      getToFile: async (sha, dest) => {
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
    remoteWorkspaceId: "ws_deps_matcher",
    projectId: "root",
    deviceId: "device_a",
    rootPath: root,
    remoteUrl: "mem://",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_deps_matcher",
    accountEpoch: 0,
    keyEpoch: 0,
  };
}

async function makeRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-deps-matcher-")));
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

async function pullTwoFiles(matcherFor?: SyncDeps["matcherFor"]): Promise<{ root: string; exists: (rel: string) => Promise<boolean> }> {
  const root = await makeRoot();
  const remote = new MemoryRemote();
  remote.advance([await remote.entry("keep.txt", "keep"), await remote.entry("skip.txt", "skip")]);
  const deps: SyncDeps = { remote, backoff: async () => {} };
  if (matcherFor) deps.matcherFor = matcherFor;
  await applyPulledManifest(root, config(root), deps, remote, await remote.latest());
  return {
    root,
    exists: async (rel) => fs.access(path.join(root, rel)).then(() => true, () => false),
  };
}

// Locks #818 fix 1: the provider is CONSULTED (not merely accepted) and its verdicts
// are what the pull applies — the proof that pull did not build its own matcher.
test("a deps-provided matcher is the one the pull filters through", async () => {
  const states: Array<{ lastSyncedManifest: Manifest }> = [];
  const provided: IgnoreMatcher = { ignores: (rel) => rel.startsWith("skip.txt") };
  const { exists } = await pullTwoFiles((state) => {
    states.push(state);
    return provided;
  });
  expect(states.length).toBe(1);
  expect(states[0]?.lastSyncedManifest.files).toEqual([]); // the state the pull actually loaded
  expect(await exists("keep.txt")).toBe(true);
  expect(await exists("skip.txt")).toBe(false);
});

// Negative control: without the dep the pull builds its own matcher, which ignores nothing.
test("without a provider the pull builds its own matcher", async () => {
  const { exists } = await pullTwoFiles();
  expect(await exists("keep.txt")).toBe(true);
  expect(await exists("skip.txt")).toBe(true);
});

// A provider that declines (its resident matcher does not describe this state) must
// fall back to the built matcher, not to "ignore nothing" or a crash.
test("a provider returning undefined falls back to the built matcher", async () => {
  let calls = 0;
  const { exists } = await pullTwoFiles(() => {
    calls++;
    return undefined;
  });
  expect(calls).toBe(1);
  expect(await exists("keep.txt")).toBe(true);
  expect(await exists("skip.txt")).toBe(true);
});
