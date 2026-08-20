import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accumulateRecoveryPage, pull, push, pushManifest, PushConflictExhaustedError, stampManifestSchemaForCommit, sync, type SyncDeps } from "../sync.js";
import { PUSH_CONFLICT_SURRENDER_MS } from "./policy.js";
import { missingBlobsChunked } from "../sync-recovery.js";
import type { WorkspaceConfig } from "../config.js";
import { loadState, saveStateUnsafeLegacyOrTest, StreamMismatchError, syncStreamId } from "../config.js";
import type { SyncRemote } from "../remote.js";
import {
  buildIgnoreMatcher,
  canonicalManifestBytes,
  canonicalManifestHashStreaming,
  decodeEnvelope,
  diffToOps,
  ENCRYPT_ADDRESS_CACHE_REL,
  encodeDeltaEnvelope,
  encryptFileToTemp,
  foldDelta,
  PhaseReport,
  scanManifest,
  type EncryptedBlob,
  type EncryptFileOptions,
  type FileEntry,
  type GitSection,
  type Manifest,
} from "../../engine/index.js";
import { setClassifyCacheHitObserverForTest } from "../publish-pipeline/shared.js";
import { listTrash } from "../../engine/trash.js";
import { projectLocalManifest } from "../local-file-projection.js";
import { FakeRemote, KEK, deps, enc, noBackoff, shaBytes } from "./publication.test-helper.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const exec = promisify(execFile);
const fakeGitSection = (): GitSection => ({
  bundleSha: sha("bundle"),
  bundleEncSha: sha("bundle-enc"),
  bundleCipherSize: 1,
  head: "ref: refs/heads/main",
  refs: { "refs/heads/main": "1".repeat(40) },
  refScope: "all",
  generatedAt: "",
});

const localEntry = (entryPath: string, content = entryPath, type: "file" | "symlink" = "file"): FileEntry => {
  const entry: FileEntry = {
    path: entryPath,
    type,
    sha256: sha(content),
    size: Buffer.byteLength(content),
    mode: type === "symlink" ? 0o777 : 0o644,
    mtimeMs: 1,
  };
  if (type === "symlink") entry.symlinkTarget = content;
  return entry;
};

test("projectLocalManifest deterministically skips complete file/symlink case-fold groups", () => {
  const local: Manifest = {
    generatedAt: "local",
    files: [
      localEntry("z.txt"),
      localEntry("BETA", "target", "symlink"),
      localEntry("alpha"),
      localEntry("Alpha"),
      localEntry("beta"),
      localEntry("ALPHA"),
    ],
  };
  const projected = projectLocalManifest(local, { generatedAt: "base", files: [] }, { ignores: () => false });

  expect(projected.caseCollisions).toEqual([
    { paths: ["ALPHA", "Alpha", "alpha"] },
    { paths: ["BETA", "beta"] },
  ]);
  expect(projected.manifest.files.map((entry) => entry.path)).toEqual(["z.txt"]);
});

test("stampManifestSchemaForCommit stamps schema 4 only when file or git compression descriptors are present", () => {
  const raw: Manifest = { generatedAt: "", files: [] };
  expect(stampManifestSchemaForCommit(raw).manifestSchema).toBeUndefined();
  expect(stampManifestSchemaForCommit({ ...raw, gitRepos: { repo: fakeGitSection() } }).manifestSchema).toBe(2);

  const compressedFile: FileEntry = {
    path: "a.txt",
    type: "file",
    sha256: sha("plain"),
    encSha: sha("enc"),
    size: 5,
    mode: 0o644,
    mtimeMs: 0,
    comp: "zstd",
    payloadSha: sha("payload"),
    cipherSize: 10,
  };
  expect(stampManifestSchemaForCommit({ generatedAt: "", files: [compressedFile] }).manifestSchema).toBe(4);
  expect(
    stampManifestSchemaForCommit({
      generatedAt: "",
      files: [],
      gitRepos: {
        repo: {
          ...fakeGitSection(),
          bundleComp: "zstd",
          bundlePayloadSha: sha("git-payload"),
        },
      },
    }).manifestSchema
  ).toBe(4);
});

const normalizedEntry = (entryPath: string, mtimeMs: number): FileEntry => ({
  path: entryPath,
  type: "file",
  sha256: "1".repeat(64),
  size: 11,
  mode: 0o644,
  mtimeMs,
  encSha: "2".repeat(64),
  comp: "zstd",
  payloadSha: "3".repeat(64),
  cipherSize: 27,
});

test("209/1 full-tree mtime rewrites normalize entry-for-entry and emit zero ops", () => {
  const base: Manifest = {
    generatedAt: "base",
    files: [normalizedEntry("a.txt", 10), normalizedEntry("b.txt", 20), normalizedEntry("c.txt", 30)],
  };
  const target: Manifest = {
    generatedAt: "target",
    files: base.files.map((entry, index) => ({ ...entry, mtimeMs: 1_000 + index })),
  };

  const committed = stampManifestSchemaForCommit(target, base);

  expect(committed.files).toEqual(base.files);
  expect(committed.files.every((entry, index) => entry === base.files[index])).toBe(true);
  expect(diffToOps(base, committed)).toEqual([]);
});

test("209/2 every non-path identity field prevents normalization; rename is set plus del", () => {
  const baseEntry: FileEntry = {
    ...normalizedEntry("identity.txt", 10),
    type: "symlink",
    symlinkTarget: "../target",
  };
  const base: Manifest = { generatedAt: "base", files: [baseEntry] };
  const changes: Array<[string, (entry: FileEntry) => FileEntry]> = [
    ["sha256", (entry) => ({ ...entry, sha256: "4".repeat(64) })],
    ["size", (entry) => ({ ...entry, size: entry.size + 1 })],
    ["mode", (entry) => ({ ...entry, mode: 0o755 })],
    ["type", (entry) => ({ ...entry, type: "file" })],
    ["symlinkTarget", (entry) => ({ ...entry, symlinkTarget: "../elsewhere" })],
    ["encSha", (entry) => ({ ...entry, encSha: "5".repeat(64) })],
    ["comp", (entry) => {
      const { comp: _comp, ...withoutComp } = entry;
      return withoutComp;
    }],
    ["payloadSha", (entry) => ({ ...entry, payloadSha: "6".repeat(64) })],
    ["cipherSize", (entry) => ({ ...entry, cipherSize: entry.cipherSize! + 1 })],
  ];

  for (const [field, change] of changes) {
    const outgoing = change({ ...baseEntry, mtimeMs: 99 });
    const committed = stampManifestSchemaForCommit({ generatedAt: field, files: [outgoing] }, base);
    expect(committed.files[0]).toBe(outgoing);
    expect(diffToOps(base, committed), field).toEqual([{ op: "set", entry: outgoing }]);
  }

  const renamed = { ...baseEntry, path: "renamed.txt", mtimeMs: 99 };
  const committed = stampManifestSchemaForCommit({ generatedAt: "rename", files: [renamed] }, base);
  expect(committed.files[0]).toBe(renamed);
  expect(diffToOps(base, committed)).toEqual([
    { op: "del", path: "identity.txt" },
    { op: "set", entry: renamed },
  ]);
});

test("209/3 unknown keys on either side disable normalization and fall through verbatim", () => {
  const plainBase = normalizedEntry("future.txt", 10);
  const plainTarget = { ...plainBase, mtimeMs: 20 };
  const futureBase = { ...plainBase, futureIdentity: "base" } as FileEntry;
  const futureTarget = { ...plainTarget, futureIdentity: "target" } as FileEntry;

  const outgoingAgainstFutureBase = { ...plainTarget };
  const againstFutureBase = stampManifestSchemaForCommit(
    { generatedAt: "target", files: [outgoingAgainstFutureBase] },
    { generatedAt: "base", files: [futureBase] },
  );
  expect(againstFutureBase.files[0]).toBe(outgoingAgainstFutureBase);
  expect(diffToOps({ generatedAt: "base", files: [futureBase] }, againstFutureBase)).toHaveLength(1);

  const futureOutgoing = stampManifestSchemaForCommit(
    { generatedAt: "target", files: [futureTarget] },
    { generatedAt: "base", files: [plainBase] },
  );
  expect(futureOutgoing.files[0]).toBe(futureTarget);
  expect(diffToOps({ generatedAt: "base", files: [plainBase] }, futureOutgoing)).toHaveLength(1);
});

test("209/4 normalized commit encodes, decodes, and folds byte-for-byte coherently", async () => {
  const base: Manifest = {
    generatedAt: "base",
    manifestSchema: 4,
    files: [normalizedEntry("changed.txt", 20), normalizedEntry("same.txt", 10)],
  };
  const target: Manifest = {
    generatedAt: "target",
    manifestSchema: 4,
    files: [
      { ...base.files[0]!, mtimeMs: 100 },
      { ...base.files[1]!, sha256: "7".repeat(64), encSha: "8".repeat(64), payloadSha: "9".repeat(64), mtimeMs: 200 },
    ],
  };
  const committed = stampManifestSchemaForCommit(target, base);
  const encoded = await encodeDeltaEnvelope(base, committed, {
    baseEncSha: "a".repeat(64),
    baseManifestHash: canonicalManifestHashStreaming(base),
    compress: true,
  });
  const decoded = await decodeEnvelope(encoded.bytes);
  if (decoded.kind !== "delta") throw new Error("expected delta");

  expect(encoded.opCount).toBe(1);
  const folded = foldDelta(base, decoded.ops, decoded.header);
  expect(canonicalManifestBytes(folded)).toEqual(canonicalManifestBytes(committed));
});

test("209/8 mixed old/new writers alternate 2-op and 0-op commits without ping-pong on the new side", () => {
  const initial: Manifest = {
    generatedAt: "initial",
    files: [normalizedEntry("a.txt", 10), normalizedEntry("b.txt", 20)],
  };
  const oldOne: Manifest = {
    generatedAt: "old-1",
    files: initial.files.map((entry) => ({ ...entry, mtimeMs: entry.mtimeMs + 100 })),
  };
  const newOneLocal: Manifest = {
    generatedAt: "new-1",
    files: oldOne.files.map((entry) => ({ ...entry, mtimeMs: entry.mtimeMs + 100 })),
  };
  const newOne = stampManifestSchemaForCommit(newOneLocal, oldOne);
  const oldTwo: Manifest = {
    generatedAt: "old-2",
    files: newOne.files.map((entry) => ({ ...entry, mtimeMs: entry.mtimeMs + 100 })),
  };
  const newTwo = stampManifestSchemaForCommit({
    generatedAt: "new-2",
    files: oldTwo.files.map((entry) => ({ ...entry, mtimeMs: entry.mtimeMs + 100 })),
  }, oldTwo);

  expect([
    diffToOps(initial, oldOne).length,
    diffToOps(oldOne, newOne).length,
    diffToOps(newOne, oldTwo).length,
    diffToOps(oldTwo, newTwo).length,
  ]).toEqual([2, 0, 2, 0]);
});

test("209/9 RBOX_MTIME_NORMALIZE=0 restores one mtime op per entry", () => {
  const previous = process.env.RBOX_MTIME_NORMALIZE;
  process.env.RBOX_MTIME_NORMALIZE = "0";
  try {
    const base: Manifest = {
      generatedAt: "base",
      files: [normalizedEntry("a.txt", 10), normalizedEntry("b.txt", 20), normalizedEntry("c.txt", 30)],
    };
    const target: Manifest = {
      generatedAt: "target",
      files: base.files.map((entry) => ({ ...entry, mtimeMs: entry.mtimeMs + 1_000 })),
    };
    const committed = stampManifestSchemaForCommit(target, base);
    expect(committed.files).toBe(target.files);
    expect(diffToOps(base, committed)).toHaveLength(base.files.length);
  } finally {
    if (previous === undefined) delete process.env.RBOX_MTIME_NORMALIZE;
    else process.env.RBOX_MTIME_NORMALIZE = previous;
  }
});

let root: string;
let cfg: WorkspaceConfig;
let savedPreflightDelta: string | undefined;
let savedPreflightFull: string | undefined;
let savedScanPrune: string | undefined;
let savedMtimeNormalize: string | undefined;
beforeEach(async () => {
  savedPreflightDelta = process.env.RBOX_PREFLIGHT_DELTA;
  savedPreflightFull = process.env.RBOX_PREFLIGHT_FULL;
  savedScanPrune = process.env.RBOX_SCAN_PRUNE;
  savedMtimeNormalize = process.env.RBOX_MTIME_NORMALIZE;
  delete process.env.RBOX_PREFLIGHT_DELTA;
  delete process.env.RBOX_PREFLIGHT_FULL;
  delete process.env.RBOX_SCAN_PRUNE;
  delete process.env.RBOX_MTIME_NORMALIZE;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-sync-test-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  // E2EE is the only mode (D6): a workspace always has an encryption key.
  cfg = {
    remoteWorkspaceId: "ws_t",
    projectId: "root",
    deviceId: "devA",
    rootPath: root,
    remoteUrl: "http://x",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_t",
    accountEpoch: 0,
    keyEpoch: 0,
  };
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
  });
});
afterEach(async () => {
  setClassifyCacheHitObserverForTest(undefined);
  if (savedPreflightDelta === undefined) delete process.env.RBOX_PREFLIGHT_DELTA;
  else process.env.RBOX_PREFLIGHT_DELTA = savedPreflightDelta;
  if (savedPreflightFull === undefined) delete process.env.RBOX_PREFLIGHT_FULL;
  else process.env.RBOX_PREFLIGHT_FULL = savedPreflightFull;
  if (savedScanPrune === undefined) delete process.env.RBOX_SCAN_PRUNE;
  else process.env.RBOX_SCAN_PRUNE = savedScanPrune;
  if (savedMtimeNormalize === undefined) delete process.env.RBOX_MTIME_NORMALIZE;
  else process.env.RBOX_MTIME_NORMALIZE = savedMtimeNormalize;
  await fs.rm(root, { recursive: true, force: true });
});

const write = (rel: string, content: string) => fs.writeFile(path.join(root, rel), content);
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8");

async function writeEncryptCache(entries: Record<string, { encSha: string; cipherSize: number; paths: string[] }>): Promise<void> {
  const file = path.join(root, ENCRYPT_ADDRESS_CACHE_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      accountId: cfg.accountId,
      workspaceId: cfg.remoteWorkspaceId,
      accountEpoch: cfg.accountEpoch,
      keyEpoch: cfg.keyEpoch,
      entries,
    })
  );
}

async function readEncryptCache(): Promise<{ entries: Record<string, { encSha: string; cipherSize: number; paths: string[] }> }> {
  return JSON.parse(await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8"));
}

function countingEncrypt() {
  let calls = 0;
  const fn: NonNullable<SyncDeps["encryptFileToTemp"]> = async (srcPath: string, kek: Buffer, tmpDir?: string, opts?: EncryptFileOptions): Promise<EncryptedBlob> => {
    calls++;
    return encryptFileToTemp(srcPath, kek, tmpDir, opts);
  };
  return { fn, calls: () => calls };
}

// ── echo-storm no-op (the guard that makes continuous sync viable) ──────────

test("no-op: pull-then-push with no local changes makes ZERO commits, sequence stable", async () => {
  const remote = new FakeRemote();
  const c = "hello\n";
  remote.injectCommit([await remote.seedEntry("a.txt", c)]);

  await pull(root, cfg, deps(remote)); // writes a.txt (decrypted), base → seq 1
  expect(await read("a.txt")).toBe(c);
  const before = remote.commitCalls;
  const { sequence: seq } = await push(root, cfg, deps(remote)); // nothing changed on disk
  expect(remote.commitCalls).toBe(before); // ZERO new commits — no echo
  expect(seq).toBe(1);
  expect(remote.headSeq()).toBe(1);
});

test("209/5 mtime-only push is a no-op; one real change plus full-tree mtime skew reaches the commit sink as one op", async () => {
  const remote = new FakeRemote();
  const base = [
    await remote.seedEntry("a.txt", "A\n"),
    await remote.seedEntry("b.txt", "B\n"),
    await remote.seedEntry("c.txt", "C\n"),
  ];
  remote.injectCommit(base);
  await pull(root, cfg, deps(remote));

  for (const entry of base) {
    await fs.utimes(path.join(root, entry.path), new Date(2_000), new Date(2_000));
  }
  const beforeNoop = remote.commitCalls;
  const noop = await push(root, cfg, deps(remote));
  expect(noop.committed).toBe(false);
  expect(remote.commitCalls).toBe(beforeNoop);

  await write("b.txt", "B changed\n");
  await fs.utimes(path.join(root, "a.txt"), new Date(3_000), new Date(3_000));
  await fs.utimes(path.join(root, "c.txt"), new Date(3_000), new Date(3_000));
  const changed = await push(root, cfg, deps(remote));
  expect(changed.committed).toBe(true);
  const committed = remote.successfulCommits.at(-1)!.manifest;
  expect(diffToOps({ generatedAt: "", files: base }, committed)).toHaveLength(1);
  expect(diffToOps({ generatedAt: "", files: base }, committed)[0]).toMatchObject({
    op: "set",
    entry: { path: "b.txt" },
  });
});

test("209/7 normalized paths never reach classifyCacheHit; rename, mode, and missing-descriptor provenance stay distinct", async () => {
  const remote = new FakeRemote();
  const mtimeBase = await remote.seedEntry("mtime.txt", "mtime\n");
  const renameBase = await remote.seedEntry("old-name.txt", "rename\n");
  const modeBase = await remote.seedEntry("mode.txt", "mode\n");
  const missingWithDescriptor = await remote.seedEntry("missing.txt", "missing\n");
  const { encSha: _encSha, ...missingBase } = missingWithDescriptor;
  const base: Manifest = {
    generatedAt: "foreign",
    files: [mtimeBase, modeBase, missingBase, renameBase].sort((a, b) => a.path.localeCompare(b.path)),
  };
  remote.injectCommit(base.files);
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 1,
    lastSyncedManifest: base,
  });

  await write("mtime.txt", "mtime\n");
  await write("new-name.txt", "rename\n");
  await write("mode.txt", "mode\n");
  await write("missing.txt", "missing\n");
  await fs.chmod(path.join(root, "mtime.txt"), 0o644);
  await fs.chmod(path.join(root, "new-name.txt"), 0o644);
  await fs.chmod(path.join(root, "mode.txt"), 0o755);
  await fs.chmod(path.join(root, "missing.txt"), 0o644);
  await writeEncryptCache({
    [missingWithDescriptor.sha256]: {
      encSha: missingWithDescriptor.encSha!,
      cipherSize: (await enc("missing\n")).ciphertext.length,
      paths: ["missing.txt"],
    },
  });

  const classified: string[] = [];
  setClassifyCacheHitObserverForTest((entryPath) => classified.push(entryPath));
  const result = await push(root, cfg, deps(remote));
  expect(result.committed).toBe(true);
  expect(classified).toEqual(["missing.txt"]);

  const committed = remote.successfulCommits.at(-1)!.manifest;
  const byPath = new Map(committed.files.map((entry) => [entry.path, entry]));
  expect(byPath.get("mtime.txt")!.mtimeMs).toBe(mtimeBase.mtimeMs);
  expect(byPath.has("old-name.txt")).toBe(false);
  expect(byPath.get("new-name.txt")!.mtimeMs).not.toBe(renameBase.mtimeMs);
  expect(byPath.get("mode.txt")!.mode).toBe(0o755);
  expect(byPath.get("mode.txt")!.mtimeMs).not.toBe(modeBase.mtimeMs);
  expect(byPath.get("missing.txt")!.encSha).toBe(missingWithDescriptor.encSha);
  expect(byPath.get("missing.txt")!.mtimeMs).not.toBe(missingBase.mtimeMs);
});

// Design 156 quarantine RESOLVED (2026-08-20): the flake was umask sensitivity —
// under umask 077 the local write landed as 0o600 while seedEntry hard-codes
// 0o644, a mode-only sameContent divergence, so pull correctly minted a conflict
// (the "conflict" channel of the combined assertion). Deterministically reproduced
// on Cloudflare CI runners and in a umask-077 container; the write helper now
// chmods explicitly, making the test umask-independent, so the skip is deleted.
test("same-SHA size mismatch commits a metadata heal without re-encrypting or conflicting", async () => {
  const remote = new FakeRemote();
  const content = "coherent bytes\n";
  await write("heal.txt", content);
  // seedEntry hard-codes mode 0o644 while writeFile's result is umask-masked
  // (0o600 under umask 077) — a mode-only sameContent divergence this test must
  // not measure. Pin the local mode to the seeded one.
  await fs.chmod(path.join(root, "heal.txt"), 0o644);
  const coherent = await remote.seedEntry("heal.txt", content);
  const poisoned = { ...coherent, size: coherent.size - 1 };
  remote.injectCommit([poisoned]);

  const actions = await pull(root, cfg, deps(remote));
  expect(actions).toEqual([]); // same plaintext identity: no write or conflict

  const counter = countingEncrypt();
  const res = await push(root, cfg, { ...deps(remote), encryptFileToTemp: counter.fn });
  // One combined assertion so a failure names its channel: a scan/churn defer
  // surfaces as deferred:["heal.txt"], a needless re-encrypt as encryptCalls:1.
  expect({ committed: res.committed, deferred: res.deferred ?? [], encryptCalls: counter.calls() }).toEqual({
    committed: true,
    deferred: [],
    encryptCalls: 0,
  });
  const healed = (await remote.latest()).manifest.files.find((f) => f.path === "heal.txt")!;
  expect(healed.size).toBe(Buffer.byteLength(content));
  expect(healed.sha256).toBe(coherent.sha256);
  expect(healed.encSha).toBe(coherent.encSha);
});

test("pull never applies a remote entry that LOCAL rules ignore (legacy .git pointer files)", async () => {
  const remote = new FakeRemote();
  // An OLD client synced a worktree `.git` pointer file before `.git` (file form)
  // became a builtin ignore. It's still in the remote manifest.
  remote.injectCommit([
    await remote.seedEntry("ok.txt", "fine\n"),
    await remote.seedEntry("wt/.git", "gitdir: /Users/old-machine/repo/.git/worktrees/wt\n"),
  ]);
  // This machine has a REAL, machine-local pointer at that path — it must survive.
  await fs.mkdir(path.join(root, "wt"), { recursive: true });
  await write("wt/.git", "gitdir: /Users/me/repo/.git/worktrees/wt\n");

  await pull(root, cfg, deps(remote));
  expect(await read("ok.txt")).toBe("fine\n"); // non-ignored entries still apply
  expect(await read("wt/.git")).toBe("gitdir: /Users/me/repo/.git/worktrees/wt\n"); // untouched

  // The ignored remote entry stays in the recorded BASE (forward-only), so the next
  // push neither echo-deletes it from the remote nor commits anything at all.
  const st = await loadState(root, syncStreamId(cfg));
  expect(st.lastSyncedManifest.files.some((f) => f.path === "wt/.git")).toBe(true);
  const before = remote.commitCalls;
  await push(root, cfg, deps(remote));
  expect(remote.commitCalls).toBe(before); // zero commits — no echo
  expect(remote.headSeq()).toBe(1);
});

test("a pull that RELAXES ignore rules applies the newly-unignored files (two-phase matcher)", async () => {
  // Filtering every action through the PRE-pull matcher would drop foo.txt here —
  // it would never land locally and the next push would delete it from the remote
  // (codex round-3 repro). Rule-file actions must apply first, then a FRESH matcher
  // filters the rest.
  const remote = new FakeRemote();
  remote.injectCommit([await remote.seedEntry(".rboxignore", "foo.txt\n")]);
  await pull(root, cfg, deps(remote)); // base: rules ignore foo.txt

  // seq 2: the rules are relaxed (ignore file removed) AND foo.txt is added.
  remote.injectCommit([await remote.seedEntry("foo.txt", "now visible\n")]);
  await pull(root, cfg, deps(remote));
  expect(await read("foo.txt")).toBe("now visible\n"); // landed despite the old rules

  const before = remote.commitCalls;
  await push(root, cfg, deps(remote));
  expect(remote.commitCalls).toBe(before); // and no echo commit afterwards
  expect(remote.headSeq()).toBe(2);
});

// ── clean push ─────────────────────────────────────────────────────────────

test("clean push uploads the ciphertext blob, commits, advances base", async () => {
  const remote = new FakeRemote();
  await write("new.txt", "fresh content\n");
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.hasBlob((await enc("fresh content\n")).encSha)).toBe(true); // stored as ciphertext
  expect(remote.hasBlob(sha("fresh content\n"))).toBe(false); // never the plaintext address
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(1);
});

test("binary (non-UTF8) content is encrypted + byte-verified by ciphertext address", async () => {
  const remote = new FakeRemote();
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f, 0xc3, 0x28]);
  await fs.writeFile(path.join(root, "blob.bin"), binary);
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.hasBlob((await enc(binary)).encSha)).toBe(true); // ciphertext addressed correctly
});

test("encrypt cache hit skips encrypt when the cached blob already exists", async () => {
  const remote = new FakeRemote();
  const content = "cached content\n";
  await write("cached.txt", content);
  const cached = await enc(content);
  await remote.blobStore().put(cached.encSha, cached.ciphertext);
  await writeEncryptCache({
    [cached.plaintextSha]: { encSha: cached.encSha, cipherSize: cached.ciphertext.length, paths: ["cached.txt"] },
  });

  const counter = countingEncrypt();
  const progress: Array<{ phase: string; bytesDone?: number; bytesTotal?: number }> = [];
  const res = await push(root, cfg, {
    ...deps(remote),
    encryptFileToTemp: counter.fn,
    onProgress: (_done, _total, phase, _label, bytes) => progress.push({ phase, bytesDone: bytes?.bytesDone, bytesTotal: bytes?.bytesTotal }),
  });

  expect(res.sequence).toBe(1);
  expect(counter.calls()).toBe(0);
  expect((await remote.latest()).manifest.files[0]!.encSha).toBe(cached.encSha);
  expect(progress.filter((p) => p.phase === "encrypt")).toEqual([{ phase: "encrypt", bytesDone: Buffer.byteLength(content), bytesTotal: Buffer.byteLength(content) }]);
  expect(progress.filter((p) => p.phase === "upload" && (p.bytesTotal ?? 0) > 0)).toEqual([]);
});

test("wrong cached encSha to a missing blob re-encrypts through the upload-time !ct path and heals the cache", async () => {
  const remote = new FakeRemote();
  const content = "actual content\n";
  await write("wrong.txt", content);
  const actual = await enc(content);
  const wrongEncSha = sha("wrong cached ciphertext address");
  await writeEncryptCache({
    [actual.plaintextSha]: { encSha: wrongEncSha, cipherSize: 999, paths: ["wrong.txt"] },
  });

  const counter = countingEncrypt();
  const uploadProgress: number[] = [];
  const res = await push(root, cfg, {
    ...deps(remote),
    encryptFileToTemp: counter.fn,
    onProgress: (_done, _total, phase, _label, bytes) => {
      if (phase === "upload" && bytes) uploadProgress.push(bytes.bytesTotal);
    },
  });

  expect(res.sequence).toBe(1);
  expect(counter.calls()).toBe(1);
  expect(remote.hasBlob(actual.encSha)).toBe(true);
  const committed = (await remote.latest()).manifest.files[0]!;
  expect(committed.encSha).toBe(actual.encSha);
  expect(committed.encSha).not.toBe(wrongEncSha);
  expect(uploadProgress).toContain(actual.ciphertext.length);

  const raw = JSON.parse(await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8"));
  expect(raw.entries[actual.plaintextSha].encSha).toBe(actual.encSha);
  expect(raw.entries[actual.plaintextSha].cipherSize).toBe(actual.ciphertext.length);
});

test("failed first-publish commit retry reuses flushed encrypt cache entries", async () => {
  const remote = new FakeRemote();
  await write("a.txt", "A\n");
  await write("b.txt", "B\n");
  await write("c.txt", "C\n");
  remote.beforeCommit = async () => {
    throw new Error("commit response lost");
  };

  const first = countingEncrypt();
  await expect(push(root, cfg, { ...deps(remote), encryptFileToTemp: first.fn, encryptCacheFlushMs: 1 })).rejects.toThrow(/commit response lost/);
  expect(first.calls()).toBe(3);

  remote.beforeCommit = undefined;
  const second = countingEncrypt();
  const res = await push(root, cfg, { ...deps(remote), encryptFileToTemp: second.fn, encryptCacheFlushMs: 1 });

  expect(res.sequence).toBe(1);
  expect(second.calls()).toBe(0);
});

test("cache hit whose path vanished after scan is deferred without encrypting", async () => {
  const remote = new FakeRemote();
  const content = "about to vanish\n";
  await write("ghost.txt", content);
  const cached = await enc(content);
  await writeEncryptCache({
    [cached.plaintextSha]: { encSha: cached.encSha, cipherSize: cached.ciphertext.length, paths: ["ghost.txt"] },
  });
  const local = await scanManifest(root, undefined, undefined);
  await fs.rm(path.join(root, "ghost.txt"));

  const counter = countingEncrypt();
  const res = await pushManifest(root, cfg, local, { ...deps(remote), encryptFileToTemp: counter.fn });

  expect(counter.calls()).toBe(0);
  expect(res.committed).toBe(false);
  expect(res.deferred).toEqual(["ghost.txt"]);
  expect(remote.headSeq()).toBe(0);
  expect((await readEncryptCache()).entries[cached.plaintextSha]).toBeUndefined();
});

test("no-op push prunes departed encrypt-cache paths absent from the scan", async () => {
  const remote = new FakeRemote();
  const stale = await enc("departed\n");
  await writeEncryptCache({
    [stale.plaintextSha]: { encSha: stale.encSha, cipherSize: stale.ciphertext.length, paths: ["departed.txt"] },
  });

  const res = await push(root, cfg, deps(remote));

  expect(res).toEqual({ sequence: 0, committed: false, caseCollisions: [] });
  expect(remote.commitCalls).toBe(0);
  expect((await readEncryptCache()).entries[stale.plaintextSha]).toBeUndefined();
});

test("base-enc reuse migrates a changed path out of its old encrypt-cache entry", async () => {
  const remote = new FakeRemote();
  const old = await enc("old\n");
  const shared = await enc("shared\n");
  await write("a.txt", "old\n");
  await write("known.txt", "shared\n");
  await push(root, cfg, deps(remote));

  await write("a.txt", "shared\n");
  const counter = countingEncrypt();
  await push(root, cfg, { ...deps(remote), encryptFileToTemp: counter.fn });

  expect(counter.calls()).toBe(0);
  const raw = await readEncryptCache();
  expect(raw.entries[old.plaintextSha]).toBeUndefined();
  expect(raw.entries[shared.plaintextSha]?.paths).toContain("known.txt");
  const latest = await remote.latest();
  const a = latest.manifest.files.find((f) => f.path === "a.txt")!;
  expect(a.sha256).toBe(shared.plaintextSha);
  expect(a.encSha).toBe(shared.encSha);
});

test("cache mapping to an existing wrong blob is detected by pull integrity, not silently accepted", async () => {
  const remote = new FakeRemote();
  const actualContent = "actual bytes\n";
  const wrongContent = "different bytes\n";
  await write("poisoned.txt", actualContent);
  const actual = await enc(actualContent);
  const wrong = await enc(wrongContent);
  await remote.blobStore().put(wrong.encSha, wrong.ciphertext);
  await writeEncryptCache({
    [actual.plaintextSha]: { encSha: wrong.encSha, cipherSize: wrong.ciphertext.length, paths: ["poisoned.txt"] },
  });

  const counter = countingEncrypt();
  await push(root, cfg, { ...deps(remote), encryptFileToTemp: counter.fn });
  expect(counter.calls()).toBe(0);
  expect((await remote.latest()).manifest.files[0]!.encSha).toBe(wrong.encSha);

  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-sync-pull-wrong-cache-"));
  try {
    await fs.mkdir(path.join(otherRoot, ".rbox", "state"), { recursive: true });
    await saveStateUnsafeLegacyOrTest(otherRoot, {
      stream: syncStreamId({ ...cfg, rootPath: otherRoot, deviceId: "devB" }),
      lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
    });
    await expect(pull(otherRoot, { ...cfg, rootPath: otherRoot, deviceId: "devB" }, deps(remote))).rejects.toThrow(/authenticate|integrity|decrypt/i);
  } finally {
    await fs.rm(otherRoot, { recursive: true, force: true });
  }
});

test("encryptAndUpload refuses to use the cache without an explicit keyEpoch", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  const badCfg: WorkspaceConfig = { ...cfg, keyEpoch: undefined };

  await expect(push(root, badCfg, deps(remote))).rejects.toThrow(/missing keyEpoch/);
  await expect(fs.stat(path.join(root, ENCRYPT_ADDRESS_CACHE_REL))).rejects.toThrow();
});

// ── 409 conflict-retry: the rescan is load-bearing ─────────────────────────

test("409 conflict: client pulls + RE-SCANS + retries, and does NOT lose the remote change", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  const theirs = "theirs\n";
  let injected = false;
  remote.beforeCommit = async () => {
    if (!injected) {
      injected = true;
      remote.injectCommit([await remote.seedEntry("theirs.txt", theirs)]);
    }
  };
  const report = PhaseReport.push();
  const { sequence: seq } = await push(root, cfg, { ...deps(remote), report });
  expect(await read("theirs.txt")).toBe(theirs); // remote change not clobbered
  expect(await read("mine.txt")).toBe("mine\n"); // our change preserved
  expect(seq).toBe(remote.headSeq());
  expect(remote.commitCalls).toBeGreaterThanOrEqual(2);
  const scanDetails = report.toJSON().phases.scan!.details as Record<string, number>;
  expect(scanDetails.filesStatted).toBeGreaterThanOrEqual(4); // initial push scan + 409 pull scan + retry rescan
});

// ── 409 give-up leaves state untouched ─────────────────────────────────────

test("409 forever: exhausts retries, throws, never commits our change, never loses it", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  let n = 0;
  remote.beforeCommit = async () => {
    n++;
    remote.injectCommit([await remote.seedEntry(`o${n}.txt`, `other${n}\n`)]);
  };
  await expect(push(root, cfg, deps(remote))).rejects.toThrow(/too many conflicts/);
  const latest = await remote.latest();
  expect(latest.manifest.files.some((f) => f.path === "mine.txt")).toBe(false); // never committed
  expect(await read("mine.txt")).toBe("mine\n"); // never lost
});

test("design 244 a2: a slow recovery pull surrenders the op before the next attempt", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  let clock = 0;
  let n = 0;
  remote.beforeCommit = async () => {
    n++;
    remote.injectCommit([await remote.seedEntry(`o.txt`, `other\n`)]);
  };

  await expect(push(root, cfg, {
    ...deps(remote),
    now: () => clock,
    // The 409 recovery pull is the expensive step (368s on the field host); one of them
    // outlasts the budget on its own, so the next attempt must never start.
    onPullApplied: () => { clock += PUSH_CONFLICT_SURRENDER_MS + 1; },
  })).rejects.toBeInstanceOf(PushConflictExhaustedError);

  expect(remote.commitCalls).toBe(1); // budget, not MAX_ATTEMPTS (=5, six attempts)
  expect(await read("mine.txt")).toBe("mine\n"); // never lost
});

test("onCommitConflict fires once per 409 (the metric the daemon tallies)", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  let injected = 0;
  remote.beforeCommit = async () => {
    if (injected < 2) {
      injected++;
      remote.injectCommit([await remote.seedEntry(`o${injected}.txt`, `o${injected}\n`)]);
    }
  };
  let conflicts = 0;
  await push(root, cfg, { remote, backoff: noBackoff, onCommitConflict: () => conflicts++ });
  expect(conflicts).toBe(2);
});

// ── 422 unsatisfied-blobs → reupload + retry ───────────────────────────────

test("422 unsatisfied blobs: client re-uploads and retries to success", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  remote.forceUnsatisfiedOnce = true;
  remote.instrumentPushSpans = true;
  const report = PhaseReport.push();
  const samples: Array<{ kind: string; opCount?: number }> = [];
  const priorMetrics = process.env.RBOX_METRICS;
  process.env.RBOX_METRICS = "1";
  try {
    const { sequence: seq } = await push(root, cfg, {
      ...deps(remote),
      report,
      telemetry: { record: (sample) => { samples.push(sample); } },
    });
    expect(seq).toBe(1);
  } finally {
    if (priorMetrics === undefined) delete process.env.RBOX_METRICS;
    else process.env.RBOX_METRICS = priorMetrics;
  }
  expect(remote.commitCalls).toBe(2); // 422 then success
  expect(samples.filter((sample) => sample.kind === "upload_lane")).toEqual([
    expect.objectContaining({ kind: "upload_lane", transport: "single", opCount: 2 }),
  ]);
  expect(samples.filter((sample) => sample.kind === "first_publish")).toHaveLength(1);
  expect(report.toJSON().phases.commit?.details).toMatchObject({ chunks: 2, payloadBytes: 34 });
});

test("delta preflight threads the unsatisfied address through a 422 retry", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  const address = (await enc("payload\n")).encSha;
  remote.forceUnsatisfiedOnce = true;

  const { sequence } = await push(root, cfg, deps(remote));

  expect(sequence).toBe(1);
  expect(remote.commitCalls).toBe(2);
  expect(remote.missingBlobCalls.filter((call) => call.includes(address))).toHaveLength(2);
});

test("delta preflight recovers a lost carried ref reported by full commit admission", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("carried.txt", "base\n");
  await push(root, cfg, deps(remote));
  const carriedAddress = (await enc("base\n")).encSha;
  remote.deleteBlob(carriedAddress);
  remote.missingBlobCalls.length = 0;
  await write("changed.txt", "new\n");

  const { sequence } = await push(root, cfg, deps(remote));

  expect(sequence).toBe(2);
  expect(remote.missingBlobCalls[0]).not.toContain(carriedAddress);
  expect(remote.missingBlobCalls.slice(1).some((call) => call.includes(carriedAddress))).toBe(true);
  expect(remote.hasBlob(carriedAddress)).toBe(true);
});

test("default preflight sends only the unique introduced address", async () => {
  const remote = new FakeRemote();
  await write("carried.txt", "base\n");
  await push(root, cfg, deps(remote));
  remote.missingBlobCalls.length = 0;
  await write("changed.txt", "new\n");

  await push(root, cfg, deps(remote));

  expect(remote.missingBlobCalls).toEqual([[(await enc("new\n")).encSha]]);
});

test("delta git-identity-only commit sends no blob-preflight request", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  cfg = { ...cfg, syncGit: true };
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await write("tracked.txt", "unchanged\n");
  await exec("git", ["add", "tracked.txt"], { cwd: root });
  await exec("git", ["commit", "-qm", "base"], { cwd: root });
  await push(root, cfg, deps(remote));
  remote.missingBlobCalls.length = 0;
  await exec("git", ["commit", "--allow-empty", "-qm", "identity only"], { cwd: root });

  const result = await push(root, cfg, deps(remote));

  expect(result.committed).toBe(true);
  expect(result.sequence).toBe(2);
  expect(remote.missingBlobCalls).toEqual([]);
});

test("flag-off preflight preserves manifest order and duplicate addresses", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "0";
  delete process.env.RBOX_PREFLIGHT_FULL;
  const remote = new FakeRemote();
  await write("a.txt", "same\n");
  await write("b.txt", "same\n");
  await write("c.txt", "different\n");
  const local = await scanManifest(root);

  const pushed = await pushManifest(root, cfg, local, deps(remote));

  expect(remote.missingBlobCalls[0]).toEqual(pushed.manifest.files.filter((f) => f.type === "file").map((f) => f.encSha!));
  expect(remote.missingBlobCalls[0]).toEqual([(await enc("same\n")).encSha, (await enc("same\n")).encSha, (await enc("different\n")).encSha]);
});

test("full preflight without delta checks the full deduped address set", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "0";
  process.env.RBOX_PREFLIGHT_FULL = "1";
  const remote = new FakeRemote();
  await write("a.txt", "same\n");
  await write("b.txt", "same\n");
  await write("c.txt", "different\n");

  const { committed } = await push(root, cfg, deps(remote));

  expect(committed).toBe(true);
  expect(remote.missingBlobCalls).toEqual([[(await enc("same\n")).encSha, (await enc("different\n")).encSha]]);
});

test("full preflight wins when both full and delta flags are enabled", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  process.env.RBOX_PREFLIGHT_FULL = "1";
  const remote = new FakeRemote();
  await write("carried.txt", "base\n");
  await push(root, cfg, deps(remote));
  remote.missingBlobCalls.length = 0;
  await write("changed.txt", "new\n");

  await push(root, cfg, deps(remote));

  expect(remote.missingBlobCalls).toEqual([[(await enc("base\n")).encSha, (await enc("new\n")).encSha]]);
});

test("delta recovery clears accumulated 422 pages after a conflict pull", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  const synthetic = [sha("discarded-conflict-a"), sha("discarded-conflict-b")];
  const originalCommit = remote.commit.bind(remote);
  let commit = 0;
  let callsBeforeConflict = -1;
  remote.commit = async (...args) => {
    commit++;
    if (commit === 1) return { unsatisfiedBlobs: synthetic, unsatisfiedTotal: synthetic.length };
    if (commit === 2) {
      remote.injectCommit([await remote.seedEntry("theirs.txt", "theirs\n")]);
      callsBeforeConflict = remote.missingBlobCalls.length;
      return originalCommit(...args);
    }
    return originalCommit(...args);
  };

  const { sequence, committed } = await push(root, cfg, deps(remote));

  expect(committed).toBe(true);
  expect(sequence).toBe(2);
  expect(remote.missingBlobCalls[callsBeforeConflict]).not.toContain(synthetic[0]);
  expect(remote.missingBlobCalls[callsBeforeConflict]).not.toContain(synthetic[1]);
});

test("delta recovery clears accumulated 422 pages after an epoch refresh", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote() as FakeRemote & {
    currentKek: () => Promise<{ kek: Uint8Array; accountId: string; accountEpoch: number; keyEpoch: number }>;
  };
  remote.currentKek = async () => ({ kek: KEK, accountId: cfg.accountId!, accountEpoch: cfg.accountEpoch!, keyEpoch: cfg.keyEpoch! });
  await write("x.txt", "payload\n");
  const synthetic = [sha("discarded-epoch-a"), sha("discarded-epoch-b")];
  const originalCommit = remote.commit.bind(remote);
  let commit = 0;
  let callsBeforeEpochRefresh = -1;
  remote.commit = async (...args) => {
    commit++;
    if (commit === 1) return { unsatisfiedBlobs: synthetic, unsatisfiedTotal: synthetic.length };
    if (commit === 2) {
      callsBeforeEpochRefresh = remote.missingBlobCalls.length;
      return { epochStale: cfg.accountEpoch! + 1 };
    }
    return originalCommit(...args);
  };

  const { sequence, committed } = await push(root, cfg, deps(remote));

  expect(committed).toBe(true);
  expect(sequence).toBe(1);
  expect(remote.missingBlobCalls[callsBeforeEpochRefresh]).not.toContain(synthetic[0]);
  expect(remote.missingBlobCalls[callsBeforeEpochRefresh]).not.toContain(synthetic[1]);
});

test("delta recovery retries with the distinct union of sequential 422 pages", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  const address = (await enc("payload\n")).encSha;
  const page1 = [sha("page-1-a"), sha("page-1-b")];
  const page2 = [sha("page-2-a"), sha("page-2-b")];
  const originalCommit = remote.commit.bind(remote);
  let page = 0;
  remote.commit = async (...args) => {
    if (page === 0) {
      page++;
      return { unsatisfiedBlobs: page1, unsatisfiedTotal: 4 };
    }
    if (page === 1) {
      page++;
      return { unsatisfiedBlobs: page2, unsatisfiedTotal: 2 };
    }
    return originalCommit(...args);
  };

  const { sequence, committed } = await push(root, cfg, deps(remote));

  expect(sequence).toBe(1);
  expect(committed).toBe(true);
  const expected = new Set([address, ...page1, ...page2]);
  expect(remote.missingBlobCalls.some((call) => call.length === expected.size && call.every((sha) => expected.has(sha)))).toBe(true);
});

test("delta recovery accumulator overflow switches the retry to a full audit", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("carried.txt", "base\n");
  await push(root, cfg, deps(remote));
  const carriedAddress = (await enc("base\n")).encSha;
  remote.missingBlobCalls.length = 0;
  await write("changed.txt", "new\n");
  const originalCommit = remote.commit.bind(remote);
  const overflowPages = Array.from({ length: 11 }, (_, page) =>
    Array.from({ length: 10_000 }, (_, index) => `recovery-p${page}-i${index}`)
  );
  const postOverflowPage = ["post-overflow-a", "post-overflow-b"];
  const pages = [...overflowPages, postOverflowPage];
  let nextPage = 0;
  remote.commit = async (...args) => {
    if (nextPage < pages.length) {
      const unsatisfiedBlobs = pages[nextPage];
      const unsatisfiedTotal = 130_000 - nextPage * 10_000;
      nextPage++;
      return { unsatisfiedBlobs, unsatisfiedTotal };
    }
    return originalCommit(...args);
  };

  const { sequence, committed } = await push(root, cfg, deps(remote));

  expect(sequence).toBe(2);
  expect(committed).toBe(true);
  const postOverflowPreflight = remote.missingBlobCalls.at(-1)!;
  expect(postOverflowPreflight).toContain(carriedAddress);
  expect(pages.flat().some((synthetic) => postOverflowPreflight.includes(synthetic))).toBe(false);
});

test("accumulateRecoveryPage clears on overflow and stays empty while latched", () => {
  const accum = new Set<string>();

  expect(accumulateRecoveryPage(accum, false, ["a", "b"])).toBe(false);
  expect(accum).toEqual(new Set(["a", "b"]));

  const overflowPage = Array.from({ length: 100_001 }, (_, index) => `recovery-${index}`);
  expect(accumulateRecoveryPage(accum, false, overflowPage)).toBe(true);
  expect(accum.size).toBe(0);

  expect(accumulateRecoveryPage(accum, true, ["post-overflow"])).toBe(true);
  expect(accum.size).toBe(0);
});

test("missingBlobsChunked splits checks at 50,000 and unions missing results", async () => {
  const shas = Array.from({ length: 50_001 }, (_, i) => `chunk-${i}`);
  const calls: string[][] = [];
  const expected = [shas[0], shas[49_999], shas[50_000]];
  const api = {
    async missingBlobs(batch: string[]) {
      calls.push([...batch]);
      return batch.filter((address) => expected.includes(address));
    },
  } satisfies Pick<SyncRemote, "missingBlobs">;

  const missing = await missingBlobsChunked(api, shas);

  expect(calls.map((call) => call.length)).toEqual([50_000, 1]);
  expect(new Set(missing)).toEqual(new Set(expected));
});

test("non-full-audit recovery chunks every blobs/check call at 50,000", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  delete process.env.RBOX_PREFLIGHT_FULL;
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  const actual = (await enc("payload\n")).encSha;
  const recovery = Array.from({ length: 50_000 }, (_, index) => index.toString(16).padStart(64, "0"))
    .map((address, index) => address === actual ? `${(index + 50_001).toString(16).padStart(64, "0")}` : address);
  const originalCommit = remote.commit.bind(remote);
  let attempt = 0;
  let callsBeforeRecovery = -1;
  remote.commit = async (...args) => {
    if (attempt++ === 0) {
      remote.commitCalls++;
      callsBeforeRecovery = remote.missingBlobCalls.length;
      return { unsatisfiedBlobs: recovery, unsatisfiedTotal: recovery.length };
    }
    return originalCommit(...args);
  };

  const { sequence, committed } = await push(root, cfg, deps(remote));

  expect(committed).toBe(true);
  expect(sequence).toBe(1);
  const retryCalls = remote.missingBlobCalls.slice(callsBeforeRecovery);
  expect(retryCalls.map((call) => call.length)).toEqual([50_000, 1]);
  expect(retryCalls.every((call) => call.length <= 50_000)).toBe(true);
});

test("422 decreasing missingTotal pages can progress beyond the fixed retry budget", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  remote.forceUnsatisfiedTotals = [60_000, 50_000, 40_000, 30_000, 20_000, 10_000];

  const { sequence: seq } = await push(root, cfg, deps(remote));

  expect(seq).toBe(1);
  expect(remote.commitCalls).toBe(7); // six capped 422 pages, then success
});

test("422 non-decreasing missingTotal still exhausts the existing retry budget", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  remote.forceUnsatisfiedTotals = Array.from({ length: 10 }, () => 10_000);

  await expect(push(root, cfg, deps(remote))).rejects.toThrow(/server keeps reporting missing blobs/);
  expect(remote.headSeq()).toBe(0);
  expect(remote.commitCalls).toBe(6);
});

// ── live-folder TOCTOU: 400 sha_mismatch → re-scan + retry (self-heal) ──────

test("sha_mismatch once: a file that changes under the push RE-SCANS + retries + commits (does NOT abort)", async () => {
  const remote = new FakeRemote();
  const content = "live edit in progress\n";
  await write("f.txt", content);
  // The server rejects the first PUT of this ciphertext (as if the source moved between
  // encrypt-time and the streamed upload); the client must not abort the whole push.
  remote.forceShaMismatchOnce = (await enc(content)).encSha;

  const { sequence: seq } = await push(root, cfg, deps(remote));

  expect(seq).toBe(1); // committed — the push self-healed
  expect(remote.headSeq()).toBe(1);
  expect(remote.hasBlob((await enc(content)).encSha)).toBe(true); // ciphertext landed on retry
  expect((await remote.latest()).manifest.files.some((f) => f.path === "f.txt")).toBe(true);
});

// ── case-collision partial progress ──────────────────────────────────────────

test("case-colliding genesis paths are both skipped while a safe sibling commits", async () => {
  const remote = new FakeRemote();
  await write("safe.txt", "safe\n");
  const scanned = await scanManifest(root);
  const local = { ...scanned, files: [...scanned.files, localEntry("Lucky Meat.md"), localEntry("Lucky meat.md")] };
  const observed: Array<{ authority: string; paths: string[][] }> = [];

  const result = await pushManifest(root, cfg, local, {
    ...deps(remote),
    onCaseCollisionObservation: ({ authority, caseCollisions }) => observed.push({
      authority,
      paths: caseCollisions.map((group) => [...group.paths]),
    }),
  }, { localFileObservation: { authority: "authoritative" } });

  expect(result.committed).toBe(true);
  expect(result.caseCollisions).toEqual([{ paths: ["Lucky Meat.md", "Lucky meat.md"] }]);
  expect(observed).toEqual([{ authority: "authoritative", paths: [["Lucky Meat.md", "Lucky meat.md"]] }]);
  expect((await remote.latest()).manifest.files.map((entry) => entry.path)).toEqual(["safe.txt"]);
});

test("collision projection keeps raw disk paths live in the encryption-address cache", async () => {
  const remote = new FakeRemote();
  await write("safe.txt", "safe\n");
  const upper = await enc("upper");
  const lower = await enc("lower");
  await writeEncryptCache({
    [upper.plaintextSha]: { encSha: upper.encSha, cipherSize: upper.ciphertext.length, paths: ["A"] },
    [lower.plaintextSha]: { encSha: lower.encSha, cipherSize: lower.ciphertext.length, paths: ["a"] },
  });
  const scanned = await scanManifest(root);
  const local = { ...scanned, files: [...scanned.files, localEntry("A", "upper"), localEntry("a", "lower")] };

  await pushManifest(root, cfg, local, deps(remote), {
    localFileObservation: { authority: "authoritative" },
  });

  const cache = await readEncryptCache();
  expect(cache.entries[upper.plaintextSha]?.paths).toEqual(["A"]);
  expect(cache.entries[lower.plaintextSha]?.paths).toEqual(["a"]);
});

test("case collision carries the exact prior spelling and bytes while safe changes continue", async () => {
  const remote = new FakeRemote();
  await write("Legacy.txt", "v1\n");
  await write("delete-me.txt", "gone next\n");
  await push(root, cfg, deps(remote));
  const base = (await remote.latest()).manifest.files.find((entry) => entry.path === "Legacy.txt")!;

  await write("Legacy.txt", "v2\n");
  await fs.rm(path.join(root, "delete-me.txt"));
  await write("safe.txt", "safe\n");
  const scanned = await scanManifest(root);
  const local = { ...scanned, files: [...scanned.files, localEntry("legacy.txt", "other\n")] };
  const result = await pushManifest(root, cfg, local, deps(remote), {
    localFileObservation: { authority: "authoritative" },
  });

  const published = await remote.latest();
  expect(result.committed).toBe(true);
  expect(result.caseCollisions).toEqual([{ paths: ["Legacy.txt", "legacy.txt"] }]);
  expect(published.manifest.files.find((entry) => entry.path === "Legacy.txt")?.sha256).toBe(base.sha256);
  expect(published.manifest.files.some((entry) => entry.path === "legacy.txt")).toBe(false);
  expect(published.manifest.files.some((entry) => entry.path === "safe.txt")).toBe(true);
  expect(published.manifest.files.some((entry) => entry.path === "delete-me.txt")).toBe(false);
});

test("case collision carries a differently-spelled base member and ignore carry can expose the group", async () => {
  const remote = new FakeRemote();
  await write("FOO", "base\n");
  await push(root, cfg, deps(remote));
  await fs.rm(path.join(root, "FOO"));
  await write(".rboxignore", "FOO\n");
  const scanned = await scanManifest(root);
  const local = { ...scanned, files: [...scanned.files, localEntry("foo", "local\n")] };

  const result = await pushManifest(root, cfg, local, deps(remote), {
    localFileObservation: { authority: "authoritative" },
  });

  expect(result.caseCollisions).toEqual([{ paths: ["FOO", "foo"] }]);
  const paths = (await remote.latest()).manifest.files.map((entry) => entry.path);
  expect(paths).toContain("FOO");
  expect(paths).not.toContain("foo");
  expect(paths).toContain(".rboxignore");
});

test("an all-collision candidate observes a warning but makes no empty commit", async () => {
  const remote = new FakeRemote();
  const local: Manifest = { generatedAt: "local", files: [localEntry("A"), localEntry("a")] };
  const observations: string[][][] = [];

  const result = await pushManifest(root, cfg, local, {
    ...deps(remote),
    onCaseCollisionObservation: ({ caseCollisions }) => observations.push(caseCollisions.map((group) => [...group.paths])),
  }, { localFileObservation: { authority: "authoritative" } });

  expect(result.committed).toBe(false);
  expect(remote.commitCalls).toBe(0);
  expect(result.caseCollisions).toEqual([{ paths: ["A", "a"] }]);
  expect(observations).toEqual([[['A', 'a']]]);
});

test("422 retries preserve the raw collision observation and do not re-observe", async () => {
  const remote = new FakeRemote();
  remote.forceUnsatisfiedOnce = true;
  await write("safe.txt", "safe\n");
  const scanned = await scanManifest(root);
  const local = { ...scanned, files: [...scanned.files, localEntry("A"), localEntry("a")] };
  const observations: string[][][] = [];

  const result = await pushManifest(root, cfg, local, {
    ...deps(remote),
    onCaseCollisionObservation: ({ caseCollisions }) => observations.push(caseCollisions.map((group) => [...group.paths])),
  }, { localFileObservation: { authority: "authoritative" } });

  expect(remote.commitCalls).toBe(2);
  expect(result.caseCollisions).toEqual([{ paths: ["A", "a"] }]);
  expect(observations).toEqual([[['A', 'a']]]);
});

test("409 recovery replaces an authoritative collision observation from its fresh rescan", async () => {
  const remote = new FakeRemote();
  await write("safe.txt", "safe\n");
  const scanned = await scanManifest(root);
  const local = { ...scanned, files: [...scanned.files, localEntry("A"), localEntry("a")] };
  const observations: string[][][] = [];
  let injected = false;
  remote.beforeCommit = async () => {
    if (injected) return;
    injected = true;
    remote.injectCommit([await remote.seedEntry("remote.txt", "remote\n")]);
  };

  const result = await pushManifest(root, cfg, local, {
    ...deps(remote),
    onCaseCollisionObservation: ({ caseCollisions }) => observations.push(caseCollisions.map((group) => [...group.paths])),
  }, { localFileObservation: { authority: "authoritative" } });

  expect(result.committed).toBe(true);
  expect(result.caseCollisions).toEqual([]);
  expect(observations).toEqual([[['A', 'a']], []]);
});

test("preserve-mode publication retains a prior collision episode", async () => {
  const remote = new FakeRemote();
  await write("safe.txt", "safe\n");
  const local = await scanManifest(root);
  const prior = [{ paths: ["Old", "old"] }];

  const result = await pushManifest(root, cfg, local, deps(remote), {
    localFileObservation: { authority: "preserve", caseCollisions: prior },
  });

  expect(result.caseCollisions).toEqual(prior);
});

test("a 409 disk rescan upgrades preserve mode to authoritative warning truth", async () => {
  const remote = new FakeRemote();
  await write("safe.txt", "safe\n");
  const local = await scanManifest(root);
  const prior = [{ paths: ["Old", "old"] }];
  const observations: Array<{ authority: string; groups: string[][] }> = [];
  let injected = false;
  remote.beforeCommit = async () => {
    if (injected) return;
    injected = true;
    remote.injectCommit([await remote.seedEntry("remote.txt", "remote\n")]);
  };

  const result = await pushManifest(root, cfg, local, {
    ...deps(remote),
    onCaseCollisionObservation: ({ authority, caseCollisions }) => observations.push({
      authority,
      groups: caseCollisions.map((group) => [...group.paths]),
    }),
  }, { localFileObservation: { authority: "preserve", caseCollisions: prior } });

  expect(result.caseCollisions).toEqual([]);
  expect(observations).toEqual([
    { authority: "preserve", groups: [["Old", "old"]] },
    { authority: "authoritative", groups: [] },
  ]);
});

test("collision observation failures are advisory and cannot fail safe publication", async () => {
  const remote = new FakeRemote();
  await write("safe.txt", "safe\n");
  const scanned = await scanManifest(root);
  const local = { ...scanned, files: [...scanned.files, localEntry("A"), localEntry("a")] };
  const warnings: string[] = [];

  const result = await pushManifest(root, cfg, local, {
    ...deps(remote),
    onCaseCollisionObservation: async () => { throw new Error("sidecar unavailable"); },
    warningSink: (line) => warnings.push(line),
  }, { localFileObservation: { authority: "authoritative" } });

  expect(result.committed).toBe(true);
  expect(warnings).toEqual(["rbox: could not record path-collision warning: sidecar unavailable"]);
});

// ── live-folder partial progress: a churning file is DEFERRED, the rest commits ──

test("a file that NEVER settles is deferred; the push SUCCEEDS committing the OTHER (stable) files", async () => {
  const remote = new FakeRemote();
  await write("stable.txt", "stable content\n");
  await write("churner.txt", "never settles\n");
  // The churner's ciphertext is rejected on every attempt (it keeps changing under us);
  // its bounded per-file retries exhaust → it's deferred, NOT a whole-push abort.
  remote.forceShaMismatchAlways = (await enc("never settles\n")).encSha;

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.sequence).toBe(1); // committed — the push made progress (did not abort)
  expect(remote.headSeq()).toBe(1);
  expect(res.deferred).toEqual(["churner.txt"]); // the churner is reported as deferred (count/paths)

  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "churner.txt")).toBe(false); // never-synced deferred → OMITTED
  expect(committed.files.some((f) => f.path === "stable.txt")).toBe(true); // the stable file committed
  expect(remote.hasBlob((await enc("stable content\n")).encSha)).toBe(true);
  // Invariant: the committed manifest references no blob that isn't present on the server.
  for (const f of committed.files) if (f.type === "file") expect(remote.hasBlob(f.encSha!)).toBe(true);
});

test("retry_later defers one file without retrying its upload or blocking stable progress", async () => {
  const remote = new FakeRemote();
  await write("stable.txt", "stable content\n");
  await write("fenced.txt", "fenced content\n");
  remote.forceRetryLater = (await enc("fenced content\n")).encSha;

  const res = await pushManifest(root, cfg, await scanManifest(root), deps(remote));

  expect(res.sequence).toBe(1);
  expect(res.deferred).toEqual(["fenced.txt"]);
  expect(res.retryLater).toEqual(["fenced.txt"]);
  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "fenced.txt")).toBe(false);
  expect(committed.files.some((f) => f.path === "stable.txt")).toBe(true);
});

test("a file that VANISHES between scan and encrypt is deferred; the push commits the rest", async () => {
  const remote = new FakeRemote();
  await write("stable.txt", "stable content\n");
  await write("ghost.txt", "about to vanish\n");

  const local = await scanManifest(root, undefined, undefined);
  await fs.rm(path.join(root, "ghost.txt")); // vanished after scan, before encrypt (agent/build churn)
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.sequence).toBe(1); // committed — one vanished file must not abort the push
  expect(res.deferred).toEqual(["ghost.txt"]);
  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "ghost.txt")).toBe(false); // never-synced → omitted
  expect(committed.files.some((f) => f.path === "stable.txt")).toBe(true);
  for (const f of committed.files) if (f.type === "file") expect(remote.hasBlob(f.encSha!)).toBe(true);
});

test("scan-to-encrypt source change defers without metadata patch, then a settled cycle commits one coherent image", async () => {
  const remote = new FakeRemote();
  await write("append.log", "before\n");
  const scanned = await scanManifest(root);
  const scannedEntry = scanned.files.find((f) => f.path === "append.log")!;
  let injected = false;
  const encrypt: NonNullable<SyncDeps["encryptFileToTemp"]> = async (srcPath, kek, tmpDir, opts) => {
    if (!injected) {
      injected = true;
      await fs.appendFile(srcPath, "after\n");
    }
    return encryptFileToTemp(srcPath, kek, tmpDir, opts);
  };

  const first = await pushManifest(root, cfg, scanned, { ...deps(remote), encryptFileToTemp: encrypt });
  expect(first.committed).toBe(false);
  expect(first.deferred).toEqual(["append.log"]);
  expect(scannedEntry.size).toBe(Buffer.byteLength("before\n"));
  expect(scannedEntry.sha256).toBe(sha("before\n"));
  expect(remote.headSeq()).toBe(0);

  const second = await push(root, cfg, deps(remote));
  expect(second.committed).toBe(true);
  const entry = (await remote.latest()).manifest.files.find((f) => f.path === "append.log")!;
  const bytes = await fs.readFile(path.join(root, "append.log"));
  expect(entry.size).toBe(bytes.length);
  expect(entry.sha256).toBe(shaBytes(bytes));

  const other = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-source-change-pull-"));
  try {
    await saveStateUnsafeLegacyOrTest(other, {
      stream: syncStreamId({ ...cfg, rootPath: other, deviceId: "settled-reader" }),
      lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
    });
    await pull(other, { ...cfg, rootPath: other, deviceId: "settled-reader" }, deps(remote));
    expect(Buffer.from(await fs.readFile(path.join(other, "append.log"))).equals(bytes)).toBe(true);
  } finally {
    await fs.rm(other, { recursive: true, force: true });
  }
});

test("a mismatch ONCE then settles is INCLUDED (bounded per-file retry heals it, not deferred)", async () => {
  const remote = new FakeRemote();
  const content = "flickers once\n";
  await write("f.txt", content);
  remote.forceShaMismatchOnce = (await enc(content)).encSha; // 400s once, then heals

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.sequence).toBe(1);
  expect(res.deferred).toEqual([]); // healed on retry → NOT deferred
  expect((await remote.latest()).manifest.files.some((f) => f.path === "f.txt")).toBe(true);
});

test("a previously-synced file that starts churning carries its BASE version (never a deletion)", async () => {
  const remote = new FakeRemote();
  await write("doc.txt", "v1\n");
  await push(root, cfg, deps(remote)); // doc.txt synced at v1
  expect((await remote.latest()).manifest.files.some((f) => f.path === "doc.txt")).toBe(true);

  // doc.txt now churns to v2 whose ciphertext never lands; a sibling changes cleanly.
  await write("doc.txt", "v2\n");
  await write("other.txt", "fresh\n");
  remote.forceShaMismatchAlways = (await enc("v2\n")).encSha;

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.deferred).toEqual(["doc.txt"]);
  const committed = (await remote.latest()).manifest;
  const doc = committed.files.find((f) => f.path === "doc.txt");
  expect(doc).toBeDefined(); // carried forward — NOT read as a deletion on other machines
  expect(doc!.sha256).toBe(sha("v1\n")); // its BASE (v1) entry, not the un-uploadable v2
  expect(remote.hasBlob(doc!.encSha!)).toBe(true); // the carried base blob is present
  expect(committed.files.some((f) => f.path === "other.txt")).toBe(true); // sibling committed
});

test("convergent duplicates (identical content) commit under ONE shared blob, both paths present", async () => {
  const remote = new FakeRemote();
  const content = "shared bytes\n";
  await write("a.txt", content);
  await write("b.txt", content); // identical → same encSha (convergent)

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.deferred).toEqual([]);
  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "a.txt")).toBe(true);
  expect(committed.files.some((f) => f.path === "b.txt")).toBe(true);
  const encSha = (await enc(content)).encSha;
  expect(committed.files.filter((f) => f.type === "file").every((f) => f.encSha === encSha)).toBe(true);
  expect(remote.hasBlob(encSha)).toBe(true);
});

test("when EVERY change is deferred and git is unchanged, the push makes NO (empty) commit", async () => {
  const remote = new FakeRemote();
  await write("churner.txt", "never\n");
  remote.forceShaMismatchAlways = (await enc("never\n")).encSha;

  const before = remote.commitCalls;
  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(remote.commitCalls).toBe(before); // no commit attempted — nothing stable to commit
  expect(res.sequence).toBe(0); // base sequence unchanged
  expect(res.deferred).toEqual(["churner.txt"]);
});

// ── pull validation: invalid remote manifest never touches disk / base ──────

test("pull rejects an invalid remote manifest and does not advance base", async () => {
  const remote = new FakeRemote();
  // Path-traversal entry (invalid) at head — rejected by client-side validation
  // BEFORE any blob fetch/decrypt (the client is the sole validator under E2EE).
  remote.injectCommit([{ path: "../escape", type: "file", sha256: sha("x"), encSha: sha("x"), size: 1, mode: 0o644, mtimeMs: 1 }]);
  await expect(pull(root, cfg, deps(remote))).rejects.toThrow(/invalid remote manifest/);
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(0); // base unchanged
});

// ── forward-only ignore carry (M3b) ────────────────────────────────────────

test("a now-ignored, previously-synced file is carried forward (not seen as a deletion)", async () => {
  const remote = new FakeRemote();
  await write("keep.env", "K=V\n");
  await push(root, cfg, deps(remote));
  expect((await remote.latest()).manifest.files.some((f) => f.path === "keep.env")).toBe(true);
  await write(".rboxignore", "keep.env\n");
  await push(root, cfg, deps(remote));
  const latest = await remote.latest();
  expect(latest.manifest.files.some((f) => f.path === "keep.env")).toBe(true); // carried forward
});

test("design 72: enabling respectGitignore deletes nothing and stops updating newly ignored untracked files", async () => {
  const remote = new FakeRemote();
  await fs.mkdir(path.join(root, "junk"), { recursive: true });
  await write("junk/cache.txt", "v1\n");
  await push(root, cfg, deps(remote));
  const before = (await remote.latest()).manifest.files.find((f) => f.path === "junk/cache.txt")!;
  expect(before).toBeDefined();

  cfg = { ...cfg, respectGitignore: true };
  await write(".gitignore", "junk/\n");
  await write("junk/cache.txt", "v2\n");
  await push(root, cfg, deps(remote));
  const latest = await remote.latest();
  const carried = latest.manifest.files.find((f) => f.path === "junk/cache.txt");
  expect(carried?.sha256).toBe(before.sha256); // stale carry, not an update and not a delete
  expect(latest.manifest.files.some((f) => f.path === ".gitignore")).toBe(true);
});

test("design 72: explicit purgeIgnored push removes now-ignored carried entries", async () => {
  const remote = new FakeRemote();
  await fs.mkdir(path.join(root, "junk"), { recursive: true });
  await write("junk/cache.txt", "v1\n");
  await push(root, cfg, deps(remote));
  expect((await remote.latest()).manifest.files.some((f) => f.path === "junk/cache.txt")).toBe(true);

  cfg = { ...cfg, respectGitignore: true };
  await write(".gitignore", "junk/\n");
  await push(root, cfg, deps(remote), true);
  expect((await remote.latest()).manifest.files.some((f) => f.path === "junk/cache.txt")).toBe(false);
});

test("design 72: purge push refuses if a known repo becomes unevaluable after the dry-run manifest", async () => {
  const remote = new FakeRemote();
  cfg = { ...cfg, respectGitignore: true };
  const repo = path.join(root, "hidden");
  await fs.mkdir(repo, { recursive: true });
  await exec("git", ["-C", repo, "init", "-qb", "main"]);
  await write(".gitignore", "hidden/\n");
  await fs.writeFile(path.join(repo, "tracked.txt"), "tracked");
  await exec("git", ["-C", repo, "add", "-f", "tracked.txt"]);
  // Design 224 §2.1: the index must be UNREADABLE, not merely absent, for the
  // refusal to fire. A commit makes HEAD resolvable, so deleting the index below
  // leaves a repo whose real tracked set is non-empty and unknowable — exactly the
  // shape the refusal exists for. Without a commit this is `indexAbsent`: an empty
  // tracked set that no longer blocks purge.
  await exec("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "tracked"]);

  const stale = await remote.seedEntry("hidden/drop.txt", "stale\n");
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [stale], manifestSchema: 2, gitRepos: { hidden: fakeGitSection() } },
  });

  const dryRunMatcher = buildIgnoreMatcher(root, {
    respectGitignore: true,
    forceTrackedEvaluation: true,
    protectTrackedPaths: true,
    knownGitRepos: ["hidden"],
  });
  const dryRunLocal = await scanManifest(root, dryRunMatcher);
  await fs.rm(path.join(repo, ".git", "index"), { force: true });

  const before = remote.commitCalls;
  await expect(pushManifest(root, cfg, dryRunLocal, deps(remote), { purgeIgnored: true })).rejects.toThrow(/refusing purge: cannot evaluate tracked files/);
  expect(remote.commitCalls).toBe(before);
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(0);
});

test("design 72: purge with respectGitignore off still preserves tracked files under a .rboxignore repo dir", async () => {
  const remote = new FakeRemote();
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await exec("git", ["-C", repo, "init", "-qb", "main"]);
  await fs.writeFile(path.join(repo, "keep.txt"), "tracked");
  await fs.writeFile(path.join(repo, "drop.txt"), "untracked");
  await exec("git", ["-C", repo, "add", "-f", "keep.txt"]);
  await push(root, cfg, deps(remote));

  const st = await loadState(root, syncStreamId(cfg));
  await saveStateUnsafeLegacyOrTest(root, {
    ...st,
    lastSyncedManifest: { ...st.lastSyncedManifest, manifestSchema: 2, gitRepos: { repo: fakeGitSection() } },
  });
  await write(".rboxignore", "repo/\n");

  await push(root, cfg, deps(remote), true);
  const paths = (await remote.latest()).manifest.files.map((f) => f.path).sort();
  expect(paths).toContain(".rboxignore");
  expect(paths).toContain("repo/keep.txt");
  expect(paths).not.toContain("repo/drop.txt");
});

// ── full sync cycle ────────────────────────────────────────────────────────

test("sync = pull then push in one call", async () => {
  const remote = new FakeRemote();
  remote.injectCommit([await remote.seedEntry("r.txt", "remote\n")]);
  await write("local.txt", "local\n");
  const { pulled, pushedSequence, initialRemoteSequence } = await sync(root, cfg, deps(remote));
  expect(pulled.some((a) => a.kind === "write")).toBe(true); // pulled r.txt
  expect(await read("r.txt")).toBe("remote\n");
  expect(pushedSequence).toBe(remote.headSeq()); // pushed local.txt on top
  expect(initialRemoteSequence).toBe(1);
});

test("sync preserves pull-time sequence zero even when the same cycle pushes", async () => {
  const remote = new FakeRemote();
  await write("local-genesis.txt", "local\n");
  const result = await sync(root, cfg, deps(remote));
  expect(result.initialRemoteSequence).toBe(0);
  expect(result.pushedSequence).toBeGreaterThan(0);
});

test("empty manifest at a nonzero sequence is not classified as genesis", async () => {
  const remote = new FakeRemote();
  remote.injectCommit([]);
  const result = await sync(root, cfg, deps(remote));
  expect(result.initialRemoteSequence).toBe(1);
});

// ── §35 phase metrics: an enabled report is populated across the real phases ──

test("§35: an enabled report times push phases and attributes the byte bases", async () => {
  const remote = new FakeRemote();
  const content = "payload\n";
  await write("x.txt", content);

  const report = PhaseReport.push();
  await push(root, cfg, { remote, backoff: noBackoff, report });

  const j = report.toJSON();
  // Every coarse push phase was timed (scan from push(), the rest from pushManifest).
  expect(Object.keys(j.phases).sort()).toEqual(["address", "commit", "encrypt", "git-plan", "missing", "scan", "state-load", "state-save", "upload"]);
  expect(j.files).toBe(1);
  expect(j.blobs).toBe(1);
  // Bases attributed to the right phase: plaintext on scan, ciphertext/changed on
  // encrypt, wire on upload — each strictly positive for a real one-file push.
  expect(j.phases.scan!.plaintextBytes).toBe(Buffer.byteLength(content));
  expect(Object.keys(j.phases.scan!.details ?? {}).sort()).toEqual([
    "attemptCount",
    "attempts",
    "dircacheOutcome",
    "dirsReusedFromCache",
    "dirsWalked",
    "filesHashed",
    "filesSkippedCacheHit",
    "filesStatted",
    "hashMs",
    "matcherMs",
    "midwriteDeferred",
    "readdirMs",
    "residualBuckets",
    "residualMs",
    "scanWallMs",
    "sortMs",
    "statMs",
  ]);
  expect(j.phases.encrypt!.count).toBe(1);
  expect(j.phases.encrypt!.ciphertextBytes).toBeGreaterThan(0);
  expect(j.phases.encrypt!.changedBytes).toBe(j.phases.encrypt!.ciphertextBytes);
  expect(j.phases.upload!.wireBytes).toBeGreaterThan(0);
  expect(j.phases["git-plan"]!.details?.state_lineage_ms).toBeGreaterThanOrEqual(0);
  expect(j.phases["git-plan"]!.details?.matcher_ms).toBeGreaterThanOrEqual(0);
  expect(j.phases.commit!.details?.delta_base_ms).toBeGreaterThanOrEqual(0);
  expect(Object.keys(j.phases.commit!.details ?? {}).sort()).toEqual(["delta_base_ms", "encBytes", "encodeMs", "encryptMs", "postMs", "refreshMs", "serverTimings", "sidecarMs", "uploadMs"]);
  expect(j.phases.commit!.details?.serverTimings).toEqual({
    totalMs: 13,
    envelopeMs: 1,
    accountingMs: 2,
    sidecarMs: 3,
    commitMs: 4,
    mirrorMs: 2,
    responseMs: 1,
  });
  // The summary line is emitted (a phase was recorded) and stays PII-free.
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  expect(lines.length).toBe(1);
  expect(lines[0]).not.toContain("x.txt");
  expect(lines[0]).toContain("scan");
  expect(lines[0]).toContain("reuse0 dc:deadline");
  expect(lines[0]).toContain("commit");
  expect(lines[0]).toContain("state_lineage=");
  expect(lines[0]).toContain("matcher=");
  expect(lines[0]).toContain("delta_base=");
  expect(lines[0]).toContain("r0.0 sc0.0 e0.0 c0.0 u0.0 p0.0 7B");
});

test("§35: an enabled report times pull phases (scan + apply) with plaintext bytes", async () => {
  const remote = new FakeRemote();
  const content = "remote\n";
  remote.injectCommit([await remote.seedEntry("r.txt", content)]);

  const report = PhaseReport.pull();
  await pull(root, cfg, { remote, backoff: noBackoff, report });

  const j = report.toJSON();
  expect(Object.keys(j.phases).sort()).toEqual(["apply", "cache-save", "git-apply", "latest", "reconcile", "scan", "state-load", "state-save", "validate"]);
  expect(j.blobs).toBe(1); // one write action applied
  expect(Object.keys(j.phases.latest!.details ?? {}).sort()).toEqual(["decryptMs", "downloadMs", "encBytes", "parseMs"]);
  expect(Object.keys(j.phases.scan!.details ?? {}).sort()).toEqual([
    "attemptCount",
    "attempts",
    "dircacheOutcome",
    "dirsReusedFromCache",
    "dirsWalked",
    "filesHashed",
    "filesSkippedCacheHit",
    "filesStatted",
    "hashMs",
    "matcherMs",
    "midwriteDeferred",
    "readdirMs",
    "residualBuckets",
    "residualMs",
    "scanWallMs",
    "sortMs",
    "statMs",
  ]);
  expect(j.phases.apply!.plaintextBytes).toBe(Buffer.byteLength(content));
  expect(j.phases["git-apply"]!.count).toBe(0);
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  expect(lines[0]).toContain("latest");
  expect(lines[0]).toContain("reuse0 dc:deadline");
  expect(lines[0]).toContain("d0.0 x0.0 p0.0 4B");
});

test("design 74 phase 0: pull reports git-apply repo timings and commonDir group count", async () => {
  const remote = new FakeRemote();
  const gitRepos = { repoA: fakeGitSection(), repoB: fakeGitSection() };
  remote.injectCommit([], gitRepos);
  cfg = { ...cfg, syncGit: true };
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: remote.headSeq(),
    lastSyncedManifest: { generatedAt: "", files: [], manifestSchema: 2, gitRepos },
  });

  const report = PhaseReport.pull();
  await pull(root, cfg, { remote, backoff: noBackoff, report });

  const phase = report.toJSON().phases["git-apply"]!;
  expect(phase.count).toBe(2);
  const details = phase.details?.gitApply as {
    runKind: string;
    repos: number;
    commonDirGroups: number;
    results: Record<string, number>;
    repoTimings: Array<{ index: number; queueMs: number; wallMs: number; result: string }>;
  };
  expect(details.runKind).toBe("steady");
  expect(details.repos).toBe(2);
  expect(details.commonDirGroups).toBe(0);
  expect(details.results.unchanged).toBe(2);
  expect(details.repoTimings).toHaveLength(2);
  expect(details.repoTimings.map((t) => t.index).sort()).toEqual([0, 1]);
  for (const t of details.repoTimings) {
    expect(t.queueMs).toBeGreaterThanOrEqual(0);
    expect(t.wallMs).toBeGreaterThanOrEqual(0);
    expect(t.result).toBe("unchanged");
  }
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  expect(lines[0]).toContain("git-apply");
  expect(lines[0]).toContain("repos=2 commonDirs=0");
  expect(lines[0]).toContain("results=unchanged=2");
  // Pooled apply (d78): repo timings emit in completion order, so assert both
  // repos appear rather than which one prints first.
  expect(lines[0]).toMatch(/repoMs=.*i0q/);
  expect(lines[0]).toMatch(/repoMs=.*i1q/);
});

test("§35: with no report, the sync path is unaffected (disabled fallback records nothing)", async () => {
  const remote = new FakeRemote();
  await write("y.txt", "z\n");
  // No `report` in deps → sync uses PhaseReport.disabled internally; push still works.
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);

  const disabled = PhaseReport.disabled("push");
  await write("z.txt", "again\n");
  await push(root, cfg, { ...deps(remote), report: disabled });
  expect(disabled.toJSON().phases).toEqual({});
  const lines: string[] = [];
  disabled.logSummaryTo((l) => lines.push(l));
  expect(lines).toEqual([]);
});

// ── design 44: rebind state-poisoning + the mass-delete guard ────────────────
// Incident (2026-07-01): `rbox setup` rebound a synced root to a brand-new EMPTY
// workspace while the old 8,600-file baseline survived in state.json — the next
// pull read every baseline file as "remotely deleted" and wiped the local tree.
// These tests pin the two independent layers that each prevent a recurrence.

test("REBIND regression: changing config alone cannot reset or reconcile an old baseline", async () => {
  const remoteOld = new FakeRemote();
  await write("a.txt", "aaa\n");
  await write("b.txt", "bbb\n");
  await push(root, cfg, deps(remoteOld)); // baseline now belongs to ws_t

  // Rebind: same root + stale state.json, different workspace, empty remote —
  // exactly what `setup → create new workspace` does over an already-synced dir.
  const cfgNew: WorkspaceConfig = { ...cfg, remoteWorkspaceId: "ws_new" };
  const remoteNew = new FakeRemote();
  await expect(pull(root, cfgNew, deps(remoteNew))).rejects.toBeInstanceOf(StreamMismatchError);
  expect(await read("a.txt")).toBe("aaa\n");
  expect(await read("b.txt")).toBe("bbb\n");
  expect((await remoteNew.latest()).sequence).toBe(0);
});

test("state ownership: another workspace's baseline throws; same workspace kept; legacy unstamped adopted", async () => {
  const remote = new FakeRemote();
  await write("a.txt", "aaa\n");
  await push(root, cfg, deps(remote)); // stamps workspaceId: ws_t at seq 1

  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(1); // kept
  const statePath = path.join(root, ".rbox", "state.json");
  const original = JSON.parse(await fs.readFile(statePath, "utf8"));
  await expect(loadState(root, syncStreamId({ ...cfg, remoteWorkspaceId: "ws_other" }))).rejects.toBeInstanceOf(StreamMismatchError);
  expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toEqual(original);

  // Legacy state file written before the stamp existed: adopted as-is.
  const legacy = original;
  delete legacy.stream;
  await fs.writeFile(statePath, JSON.stringify(legacy));
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(1);
  expect((await loadState(root, syncStreamId(cfg))).stream).toBe(syncStreamId(cfg));
});

test("mass-delete guard: a pull deleting ≥half the baseline fails closed until --allow-mass-delete", async () => {
  const remote = new FakeRemote();
  for (let i = 0; i < 120; i++) await write(`f${i}.txt`, `${i}\n`);
  await push(root, cfg, deps(remote)); // baseline: 120 files

  remote.injectCommit([]); // the remote head becomes EMPTY (poisoned/reset stream)
  await expect(pull(root, cfg, deps(remote))).rejects.toThrow(/mass-delete guard/);
  await expect(pull(root, cfg, { ...deps(remote), massDeleteHint: "rbox sync --allow-mass-delete" })).rejects.toThrow(/rbox sync --allow-mass-delete/);
  expect(await read("f0.txt")).toBe("0\n"); // fails closed BEFORE touching disk
  expect(await read("f119.txt")).toBe("119\n");

  // Explicit consent applies the deletion wave once.
  await pull(root, cfg, { ...deps(remote), allowMassDelete: true });
  await expect(fs.access(path.join(root, "f0.txt"))).rejects.toThrow();
});

test("mass-delete guard: normal-scale deletions (under half the baseline) apply without consent", async () => {
  const remote = new FakeRemote();
  for (let i = 0; i < 120; i++) await write(`f${i}.txt`, `${i}\n`);
  await push(root, cfg, deps(remote));

  // Remote deletes 30 of 120 (a big-but-legit cleanup): survives the guard.
  const head = (await remote.latest()).manifest;
  remote.injectCommit(head.files.filter((f) => Number(f.path.slice(1, -4)) < 90));
  const actions = await pull(root, cfg, deps(remote));
  expect(actions.filter((a) => a.kind === "delete")).toHaveLength(30);
  await expect(fs.access(path.join(root, "f90.txt"))).rejects.toThrow();
  expect((await listTrash(root)).some((e) => e.path === "f90.txt")).toBe(true);
  expect(await read("f89.txt")).toBe("89\n");
});

test("push reports committed=false on a no-op (the setup flow must never claim a publish that didn't happen)", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "x\n");
  const first = await push(root, cfg, deps(remote));
  expect(first.committed).toBe(true);
  const second = await push(root, cfg, deps(remote)); // nothing changed
  expect(second.committed).toBe(false);
  expect(second.sequence).toBe(first.sequence);
});
