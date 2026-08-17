import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock, type OwnedLock } from "../engine/lockfile.js";
import { loadState, resetSyncState, StreamMismatchError } from "./config.js";
import {
  ResetConsentError,
  consumeResetConsent,
  createWorkspaceWithConsent,
  inspectResetConsent,
  inspectResetConsentIntent,
  mintSetupCreateConsent,
  mintSetupExistingConsent,
  type ResetConsentWitness,
} from "./reset-consent.js";
import { authorityMarkerBytes } from "./state-plane/authority-marker.js";
import { sqliteResetPaths, stateLockPath, statePath } from "./state-plane/paths.js";
import { sqliteResetFacade } from "./state-plane/reset/index.js";
import { createStateStore } from "./state-plane/store/open.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function common(root: string) {
  return {
    root,
    observedOldStream: "https://old.test::ws_old::root",
    observedOldNonce: "0123456789abcdef0123456789abcdef",
    mintedAtRevision: 7,
  };
}

test("create consent verifies the stream-selecting tuple before POST and narrows once", async () => {
  const root = "/tmp/consent-root";
  const witness = mintSetupCreateConsent({ ...common(root), remoteUrl: "https://new.test", projectId: "root" });
  let posts = 0;
  await expect(createWorkspaceWithConsent(
    witness,
    { remoteUrl: "https://substituted.test", projectId: "root", name: "display-only" },
    async () => { posts++; return "ws_bad"; },
  )).rejects.toMatchObject({ name: "ResetConsentError", reason: "tuple-mismatch" });
  expect(posts).toBe(0);

  const created = await createWorkspaceWithConsent(
    witness,
    { remoteUrl: "https://new.test", projectId: "root", name: "unbound display name" },
    async () => { posts++; return "ws_returned"; },
  );
  expect(created.witness).toBe(witness);
  expect(posts).toBe(1);
  expect(inspectResetConsent(witness).nextStream).toBe("https://new.test::ws_returned::root");

  await expect(createWorkspaceWithConsent(
    witness,
    { remoteUrl: "https://new.test", projectId: "root" },
    async () => "ws_second",
  )).rejects.toMatchObject({ name: "ResetConsentError", reason: "already-narrowed" });
});

test("returned workspace substitution and witness replay are refused", () => {
  const root = "/tmp/consent-root";
  const witness = mintSetupExistingConsent({
    ...common(root),
    remoteUrl: "https://new.test",
    workspaceId: "ws_intended",
    projectId: "root",
  });
  expect(() => consumeResetConsent(witness, {
    root,
    observedOldStream: common(root).observedOldStream,
    observedOldNonce: common(root).observedOldNonce,
    nextStream: "https://new.test::ws_substituted::root",
  })).toThrow(ResetConsentError);

  consumeResetConsent(witness, {
    root,
    observedOldStream: common(root).observedOldStream,
    observedOldNonce: common(root).observedOldNonce,
    nextStream: "https://new.test::ws_intended::root",
  });
  expect(() => inspectResetConsent(witness)).toThrow(/already consumed/);
});

test("a shape-compatible object cannot forge reset consent", () => {
  expect(() => inspectResetConsent(Object.freeze({}) as ResetConsentWitness)).toThrow(/invalid/);
});

async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(dir, absolute);
      if (entry.isDirectory()) await walk(absolute);
      else result[relative] = (await fs.readFile(absolute)).toString("base64");
    }
  }
  await walk(dir);
  return result;
}

async function durableSnapshot(dir: string): Promise<Record<string, string>> {
  const all = await snapshot(dir);
  return Object.fromEntries(Object.entries(all).filter(([file]) =>
    !file.endsWith(".lock") && !file.includes("rbox-locks/") && !file.endsWith("locking-health.json")));
}

async function withStateLock<T>(root: string, fn: (lock: OwnedLock) => Promise<T>): Promise<T> {
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error(`test state lock unavailable: ${acquired.status}`);
  try { return await fn(acquired.lock); } finally { await acquired.lock.release(); }
}

type ExactQStandingRow = "P" | "R" | "I" | "Z" | "W1";

async function exactQStandingRoot(row: ExactQStandingRow): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-consent-q-${row.toLowerCase()}-`));
  roots.push(root);
  if (row === "W1") {
    const child = Bun.spawn({
      cmd: [process.execPath, import.meta.dir + "/state-plane/reset/crash-rig-child.ts", "w1-prepare", root, "prepare"],
      stdout: "pipe", stderr: "pipe",
    });
    expect([9, 137]).toContain(await child.exited);
    return root;
  }
  const authorityId = "a".repeat(32);
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  createStateStore(sqliteResetPaths.active(root), {
    authorityId, lineageId: "b".repeat(32), stream: "old",
    createdBy: "reset-consent-test", stateNonce: "1".repeat(32), stateRevision: 1,
  }).close();
  await fs.writeFile(statePath(root), authorityMarkerBytes(authorityId));
  await withStateLock(root, (lock) => sqliteResetFacade.begin(
    root, "next", { stream: "old", stateNonce: "1".repeat(32) }, [], {
      version: 2, authorizedNextStream: "next", consentKind: "setup-rebind", mintedAtRevision: 1,
    }, lock, {
      now: () => new Date("2026-08-15T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, size === 16 ? 2 : 3),
    },
  ));
  const boundary = row === "R" ? "after-ready" : row === "I" ? "after-installed" : row === "Z" ? "after-z-retired" : undefined;
  if (boundary) {
    await expect(withStateLock(root, (lock) => sqliteResetFacade.recover(root, "old", lock, {
      crashAt(point) { if (point === boundary) throw new Error(point); },
    }))).rejects.toThrow(boundary);
  }
  return root;
}

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exit !== 0) throw new Error(stderr);
  return stdout.trim();
}

test("loadState throws a typed mismatch without changing the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-mismatch-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify({
    stream: "old-stream",
    stateNonce: "0123456789abcdef0123456789abcdef",
    stateRevision: 3,
    lastSyncedSequence: 4,
    lastSyncedManifest: { generatedAt: "old", files: [] },
  }));
  const before = await snapshot(root);
  const error = await loadState(root, "new-stream").catch((caught) => caught);
  expect(error).toBeInstanceOf(StreamMismatchError);
  expect(error).toMatchObject({ expectedStream: "new-stream", observedStream: "old-stream", source: "state" });
  expect(await snapshot(root)).toEqual(before);
});

test("incarnation-only stream mismatch is typed and never freshened", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-marker-mismatch-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "state", "state-incarnation.json"), JSON.stringify({
    stream: "marker-stream",
    stateNonce: "fedcba9876543210fedcba9876543210",
    stateRevision: 5,
  }));
  const before = await snapshot(root);
  const error = await loadState(root, "requested-stream").catch((caught) => caught);
  expect(error).toBeInstanceOf(StreamMismatchError);
  expect(error).toMatchObject({ observedStream: "marker-stream", source: "incarnation-marker" });
  expect(await snapshot(root)).toEqual(before);
});

test("the full design-138 loadState caller inventory remains on the hard-refusal API", async () => {
  const inventory: Record<string, number> = {
    "sync/pull.ts": 5,
    // Receipt arming consumes applyStateSavePacket's installed state directly;
    // a reload after the durable arm would reopen a pre-POST failure window.
    // The epoch-stale and 422 post-disarm reloads are one ManifestCommitPort
    // member, so both classification arms share a single call site.
    "sync/push.ts": 5,
    // Workspace shape, the local-only linked-worktree inventory, and the
    // design-208 repo-residue section each read through the same
    // stream-mismatch hard-refusal API.
    "doctor-cmd.ts": 3,
    "ignore-cmd.ts": 1,
    "chain-repair.ts": 2,
    "daemon/daemon.ts": 1,
    // Eight direct reloads (including keep-mine's synchronous confirm reload)
    // in the resolve workflow, plus gitDeferralsCmd's dependency-injectable call.
    // Design 273 PR-A split the workflow into its verb transactions; the same
    // eight reloads moved with the code that performs them. Total unchanged.
    "git/resolve-artifacts.ts": 3,
    "git/resolve-command.ts": 1,
    "git/resolve-keep-mine.ts": 2,
    "git/resolve-take-theirs.ts": 2,
    "git/deferrals-command.ts": 1,
  };
  const cli = path.dirname(new URL(import.meta.url).pathname);
  let total = 0;
  for (const [relative, expected] of Object.entries(inventory)) {
    const source = await fs.readFile(path.join(cli, ...relative.split("/")), "utf8");
    const direct = source.match(/\bloadState\s*\(/g)?.length ?? 0;
    const injected = source.match(/\(deps\.loadState \?\? loadState\)\s*\(/g)?.length ?? 0;
    expect(direct + injected, relative).toBe(expected);
    total += direct + injected;
  }
  expect(total).toBe(26);

  // Status reads state through its projection port instead of calling the API
  // directly; the binding and both port reads still ride the hard-refusal path.
  const portSource = await fs.readFile(path.join(cli, "status-read-port.ts"), "utf8");
  expect(portSource).toContain("readState: loadState");
  const projectionSource = await fs.readFile(path.join(cli, "status-projection.ts"), "utf8");
  expect(projectionSource.match(/\bport\.readState\s*\(/g)?.length ?? 0).toBe(2);
});

test("nonce advance after witness validation is a zero-reset-write barrier including Git refs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-consent-barrier-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  await git(repo, "config", "user.name", "rbox test");
  await git(repo, "config", "user.email", "rbox-test@local");
  await fs.writeFile(path.join(repo, "tracked"), "before\n");
  await git(repo, "add", "tracked");
  await git(repo, "commit", "-qm", "before");

  const oldStream = "https://old.test::ws_old::root";
  const nextStream = "https://new.test::ws_new::root";
  const oldNonce = "1".repeat(32);
  const state = {
    stream: oldStream,
    stateNonce: oldNonce,
    stateRevision: 7,
    lastSyncedSequence: 4,
    lastSyncedManifest: { generatedAt: "old", files: [] },
    repoRecords: { repo: { repoGen: 0, sourceSeq: 4 } },
  };
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify(state));
  const consent = mintSetupExistingConsent({
    root, observedOldStream: oldStream, observedOldNonce: oldNonce, mintedAtRevision: 7,
    remoteUrl: "https://new.test", workspaceId: "ws_new", projectId: "root",
  });
  let afterAdvance: Record<string, string> | undefined;
  let refsAfterAdvance = "";
  await expect(resetSyncState(root, nextStream, undefined, consent, {
    afterFencedRecheck: async () => {
      await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify({
        ...state, stateNonce: "2".repeat(32), stateRevision: 8,
      }));
      afterAdvance = await durableSnapshot(root);
      refsAfterAdvance = await git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
    },
  })).rejects.toThrow("state lineage changed before journal publication");
  expect(await durableSnapshot(root)).toEqual(afterAdvance!);
  expect(await git(repo, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refsAfterAdvance);
  expect(() => inspectResetConsent(consent)).not.toThrow();
});

for (const mismatch of ["root", "old-stream", "old-nonce", "next-stream"] as const) {
  test(`A1 ${mismatch} tuple mismatch refuses without consuming the witness`, () => {
    const root = "/tmp/consent-tuple-root";
    const witness = mintSetupExistingConsent({
      ...common(root), remoteUrl: "https://new.test", workspaceId: "ws_new", projectId: "root",
    });
    const expected = {
      root,
      observedOldStream: common(root).observedOldStream,
      observedOldNonce: common(root).observedOldNonce,
      nextStream: "https://new.test::ws_new::root",
    };
    if (mismatch === "root") expected.root = "/tmp/other-root";
    if (mismatch === "old-stream") expected.observedOldStream = "other-old";
    if (mismatch === "old-nonce") expected.observedOldNonce = "f".repeat(32);
    if (mismatch === "next-stream") expected.nextStream = "https://new.test::other::root";
    expect(() => consumeResetConsent(witness, expected)).toThrow(ResetConsentError);
    expect(inspectResetConsent(witness).nextStream).toBe("https://new.test::ws_new::root");
  });
}

async function consentStateRoot(label: string): Promise<{ root: string; witness: ResetConsentWitness }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-consent-${label}-`));
  roots.push(root);
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify({
    stream: common(root).observedOldStream,
    stateNonce: common(root).observedOldNonce,
    stateRevision: 7,
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
    repoRecords: {},
  }));
  return {
    root,
    witness: mintSetupExistingConsent({
      ...common(root), remoteUrl: "https://new.test", workspaceId: "ws_new", projectId: "root",
    }),
  };
}

test("A0 empty next stream refuses before consuming a valid witness", async () => {
  const { root, witness } = await consentStateRoot("empty-next");
  await expect(resetSyncState(root, "", undefined, witness)).rejects.toThrow("next stream is empty");
  expect(() => inspectResetConsent(witness)).not.toThrow();
});

test("A2 bound state without a witness refuses with byte-exact zero mutation", async () => {
  const { root } = await consentStateRoot("missing-witness");
  const before = await durableSnapshot(root);
  await expect(resetSyncState(root, "https://new.test::ws_new::root")).rejects.toMatchObject({ name: "RebindConsentRequiredError" });
  expect(await durableSnapshot(root)).toEqual(before);
});

test("A2 witness on a no-state root refuses unconsumed with zero mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-consent-no-state-"));
  roots.push(root);
  const witness = mintSetupExistingConsent({
    ...common(root), remoteUrl: "https://new.test", workspaceId: "ws_new", projectId: "root",
  });
  await expect(resetSyncState(root, "https://new.test::ws_new::root", undefined, witness))
    .rejects.toMatchObject({ name: "RebindConsentRequiredError" });
  expect(await fs.readdir(root)).toEqual([]);
  expect(() => inspectResetConsent(witness)).not.toThrow();
});

test("A1 revision mismatch refuses before consumption and mutation", async () => {
  const { root } = await consentStateRoot("revision-mismatch");
  const witness = mintSetupExistingConsent({
    ...common(root), mintedAtRevision: 6,
    remoteUrl: "https://new.test", workspaceId: "ws_new", projectId: "root",
  });
  const before = await durableSnapshot(root);
  await expect(resetSyncState(root, "https://new.test::ws_new::root", undefined, witness))
    .rejects.toMatchObject({ name: "RebindConsentRequiredError" });
  expect(await durableSnapshot(root)).toEqual(before);
  expect(() => inspectResetConsent(witness)).not.toThrow();
});

test("A1 non-narrowed create witness is unusable and unconsumed", () => {
  const witness = mintSetupCreateConsent({
    ...common("/tmp/not-narrowed"), remoteUrl: "https://new.test", projectId: "root",
  });
  expect(() => inspectResetConsent(witness)).toThrow(/not been narrowed/);
  expect(() => inspectResetConsentIntent(witness)).not.toThrow();
});

for (const row of ["P", "R", "I", "Z", "W1"] as const) {
  test(`A2 exact-Q standing ${row} missing consent has byte-exact zero effect`, async () => {
    const root = await exactQStandingRoot(row);
    const before = await snapshot(root);
    await expect(resetSyncState(root, "next")).rejects.toMatchObject({ name: "RebindConsentRequiredError" });
    expect(await snapshot(root)).toEqual(before);
  });

  test(`A1 exact-Q standing ${row} invalid consent has byte-exact zero effect`, async () => {
    const root = await exactQStandingRoot(row);
    const before = await snapshot(root);
    await expect(resetSyncState(root, "next", undefined, Object.freeze({}) as ResetConsentWitness))
      .rejects.toMatchObject({ name: "ResetConsentError", reason: "invalid" });
    expect(await snapshot(root)).toEqual(before);
  });

  test(`A1 exact-Q standing ${row} lineage tuple mismatch has byte-exact zero effect`, async () => {
    const root = await exactQStandingRoot(row);
    const witness = mintSetupExistingConsent({
      root, observedOldStream: "wrong-old-stream", observedOldNonce: "f".repeat(32),
      mintedAtRevision: 99,
      remoteUrl: "https://new.test", workspaceId: "ws_new", projectId: "root",
    });
    const before = await snapshot(root);
    await expect(resetSyncState(root, "https://new.test::ws_new::root", undefined, witness))
      .rejects.toMatchObject({ name: "RebindConsentRequiredError" });
    expect(await snapshot(root)).toEqual(before);
    expect(() => inspectResetConsent(witness)).not.toThrow();
  });
}

test("D0 successful selected reset consumes the witness exactly once", async () => {
  const { root, witness } = await consentStateRoot("consumed-success");
  await resetSyncState(root, "https://new.test::ws_new::root", undefined, witness);
  expect((await loadState(root, "https://new.test::ws_new::root")).stream).toBe("https://new.test::ws_new::root");
  expect(() => inspectResetConsent(witness)).toThrow(/already consumed/);
});
